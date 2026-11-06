/**
 * `codekin app-server`: the hidden entry point the desktop app spawns.
 *
 * Spec: docs/DESKTOP-APP-TAURI-PLAN.md ("Launcher (D1)", D8). In order:
 *
 *  1. Make sure a credential is configured (first launch writes the default
 *     token and env file; existing or custom credentials are reused).
 *  2. Load the whole env file over the inherited environment, force
 *     FRONTEND_DIST to this package's dist/, and use the login-shell PATH.
 *  3. Hand the effective credential to the parent on a private fd
 *     (`--credential-fd`), never on stdout/stderr or in arguments.
 *  4. Probe the port: attach to a Codekin server that accepts the credential,
 *     or report why not. Only a refused connection starts a server.
 *  5. Start: import the compiled server into this process. It takes exclusive
 *     ownership of its state directories first (`data_in_use` / `data_newer`
 *     if it can't), then `started` once it listens and answers an
 *     authenticated health check.
 *
 * Event lines go to stdout as `@@codekin {json}`; everything else on
 * stdout/stderr is server log output. With `--lifetime-stdin`, EOF on stdin
 * (the parent died) shuts the server down gracefully, with a 15 s kill
 * backstop for the whole process group.
 */

import { closeSync, writeSync } from 'fs'
import { execFileSync } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import {
  PACKAGE_ROOT,
  buildServerEnv,
  configPaths,
  decideFromProbe,
  ensureCredential,
  findFrontendDist,
  findServerScript,
  formatCredential,
  formatEvent,
  parseCredentialFd,
  probeServer,
  readEnvFile,
  resolveCredential,
  resolveLoginPath,
  resolvePort,
  resolveProbeHost,
} from './launch.mjs'

/** Exit codes, so a shell that missed an event line still knows what happened. */
export const EXIT = {
  attach: 0,
  config_error: 2,
  auth_error: 3,
  port_conflict: 4,
  unresponsive: 5,
}

const SHUTDOWN_BACKSTOP_MS = 15_000

/** Write all of `text` to `fd` synchronously; stdout pipes may be non-blocking (EAGAIN). */
function writeAllSync(fd, text) {
  const buf = Buffer.from(text)
  let off = 0
  let spins = 0
  while (off < buf.length) {
    try {
      off += writeSync(fd, buf, off)
      spins = 0
    } catch (err) {
      if (err && err.code === 'EAGAIN' && spins++ < 10_000) continue
      throw err
    }
  }
}

function emit(event, fields) {
  writeAllSync(1, formatEvent(event, fields))
}

function log(message) {
  writeAllSync(2, `[app-server] ${message}\n`)
}

/** PIDs in process group `pgid` other than this process (POSIX `ps`). */
function otherGroupMembers(pgid) {
  try {
    const out = execFileSync('ps', ['-A', '-o', 'pid=,pgid='], { encoding: 'utf-8' })
    const pids = []
    for (const line of out.split('\n')) {
      const [pid, group] = line.trim().split(/\s+/).map(Number)
      if (group === pgid && pid !== process.pid && Number.isInteger(pid)) pids.push(pid)
    }
    return pids
  } catch {
    return []
  }
}

/** Whether this process leads its process group (the shell spawns it with `process_group(0)`). */
function isGroupLeader() {
  try {
    const out = execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf-8' })
    return Number(out.trim()) === process.pid
  } catch {
    return false
  }
}

/**
 * Final descendant cleanup for an owned server: on exit, SIGKILL whatever is
 * left in this process group. Runs from the 'exit' handler, so it also
 * covers `process.exit(0)` at the end of gracefulShutdown. Only applies when
 * this process leads its group, so it can never reach a parent's group.
 */
function installGroupCleanup() {
  if (!isGroupLeader()) return
  process.on('exit', () => {
    for (const pid of otherGroupMembers(process.pid)) {
      try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    }
  })
}

/** EOF on stdin means the parent shell is gone: shut down, with a whole-group kill backstop. */
function watchLifetimeStdin() {
  let triggered = false
  const onEof = () => {
    if (triggered) return
    triggered = true
    log('stdin closed (parent exited); shutting down')
    const backstop = setTimeout(() => {
      log('graceful shutdown timed out; killing the process group')
      try { process.kill(-process.pid, 'SIGKILL') } catch { process.exit(1) }
    }, SHUTDOWN_BACKSTOP_MS)
    backstop.unref()
    // ws-server's SIGTERM handler runs gracefulShutdown; before the server is
    // loaded, the default disposition simply ends the process.
    process.kill(process.pid, 'SIGTERM')
  }
  process.stdin.on('end', onEof)
  process.stdin.on('close', onEof)
  process.stdin.on('error', onEof)
  process.stdin.on('data', () => { /* the parent sends nothing; ignore */ })
  process.stdin.resume()
}

/**
 * Run the launcher. Resolves with an exit code for the non-start outcomes;
 * after a successful start it keeps the process alive serving and only ends
 * through the server's own shutdown.
 */
export async function runAppServer({ argv = [], env = process.env, home = homedir(), packageRoot = PACKAGE_ROOT } = {}) {
  let credentialFd
  try {
    credentialFd = parseCredentialFd(argv)
  } catch (err) {
    emit('config_error', { reason: err.message })
    return EXIT.config_error
  }
  if (argv.includes('--lifetime-stdin')) watchLifetimeStdin()

  // 1. Credential configured (first launch writes the defaults).
  const ensured = ensureCredential({ home, baseEnv: env })
  if (!ensured.ok) {
    emit('config_error', { reason: ensured.reason, source: ensured.source ?? undefined })
    return EXIT.config_error
  }
  if (ensured.created) log(`generated a token in ${configPaths(home).tokenFile}`)

  // 2. Environment.
  const fileVars = readEnvFile(configPaths(home).envFile)
  const serverEnv = buildServerEnv({
    baseEnv: env,
    fileVars,
    frontendDist: findFrontendDist(packageRoot),
    forceFrontend: true,
  })
  let pathSource = 'env-file'
  if (!fileVars.PATH) {
    if (env.CODEKIN_LOGIN_PATH === '0') {
      pathSource = 'inherited'
    } else {
      const resolved = resolveLoginPath({ shell: env.SHELL, inheritedPath: env.PATH, home })
      serverEnv.PATH = resolved.path
      pathSource = resolved.source
      if (resolved.warning) log(`login-shell PATH unavailable (${resolved.warning}); using a fallback PATH`)
    }
  }

  const credential = resolveCredential(serverEnv)
  if (!credential.ok) {
    emit('config_error', { reason: credential.reason, source: credential.source ?? undefined })
    return EXIT.config_error
  }

  // 3. Private credential handoff, before any outcome event.
  if (credentialFd !== null) {
    try {
      writeAllSync(credentialFd, formatCredential(credential))
      closeSync(credentialFd)
    } catch (err) {
      emit('config_error', { reason: `credential fd ${credentialFd}: ${err.code ?? 'write failed'}` })
      return EXIT.config_error
    }
  }

  // 4. Probe.
  const port = resolvePort(serverEnv)
  const host = resolveProbeHost(serverEnv)
  const probe = await probeServer({ host, port, token: credential.token })
  const decision = decideFromProbe(probe)
  if (decision !== 'start') {
    const fields = { port, host, version: probe.version }
    if (decision === 'auth_error') fields.source = credential.source
    emit(decision, fields)
    return EXIT[decision]
  }

  // 5. Start the server in this process.
  let serverScript
  try {
    serverScript = findServerScript(packageRoot)
  } catch (err) {
    emit('config_error', { reason: err.message })
    return EXIT.config_error
  }
  if (!serverScript.compiled) {
    emit('config_error', { reason: 'app-server needs the compiled server (server/dist); run npm run build' })
    return EXIT.config_error
  }

  for (const [key, value] of Object.entries(serverEnv)) process.env[key] = value
  installGroupCleanup()

  const serverDir = join(packageRoot, 'server', 'dist')
  const { serverLifecycle } = await import(pathToFileURL(join(serverDir, 'server-lifecycle.js')).href)
  serverLifecycle.once('listening', () => {
    void (async () => {
      const ready = await probeServer({ host, port, token: credential.token })
      if (ready.state === 'codekin' && ready.auth === 'ok') {
        emit('started', { port, host, version: ready.version, pathSource })
      } else {
        // Listening but not answering as itself: let the shell show logs and retry.
        log(`started but readiness check failed (${ready.state}${ready.auth ? `/${ready.auth}` : ''})`)
        emit('unresponsive', { port, host })
      }
    })()
  })
  serverLifecycle.once('ownership_error', (err) => {
    // ws-server exits right after this, before opening any state.
    if (err.code === 'data_newer') {
      emit('data_newer', { port, host, dir: err.dir, writerVersion: err.writerVersion, version: err.serverVersion })
    } else {
      emit('data_in_use', { port, host, dir: err.dir })
    }
  })
  serverLifecycle.once('listen_error', (err) => {
    // ws-server exits right after this. Another server won the bind race;
    // the shell re-runs the full probe flow.
    emit('bind_failed', { port, host, reason: err.code ?? err.message })
  })

  await import(pathToFileURL(serverScript.script).href)
  return null
}
