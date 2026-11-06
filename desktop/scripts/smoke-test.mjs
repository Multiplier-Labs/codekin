#!/usr/bin/env node
/**
 * Isolated smoke test of the app's server payload (docs/DESKTOP-APP-TAURI-PLAN.md, "Testing").
 *
 * Runs `codekin app-server` from the payload with the bundled Node, the way
 * the shell will, in a throwaway world: temporary HOME, config, DATA_DIR and
 * repos root, a minimal environment (nothing inherited from the builder, so
 * no real credentials, sessions, harness config or relay pairing), and a free
 * loopback port. Requires the `started` event from this process (an `attach`
 * fails), then checks /api/ping, authenticated /api/health, the bundled
 * frontend, and the SQLite state in the temporary directories, and finally a
 * clean shutdown through the stdin lifetime pipe. The process group is always
 * reaped and the temporary files removed.
 *
 * Usage: node scripts/smoke-test.mjs [--node <node binary>] [--payload <dir>]
 * Defaults: the sidecar for this host and desktop/build/codekin.
 */

import { execFileSync, spawn } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { createServer } from 'net'
import { arch, platform, tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const DESKTOP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EVENT_TIMEOUT_MS = 60_000
const SHUTDOWN_TIMEOUT_MS = 25_000
const MAX_PORT_ATTEMPTS = 3

function log(message) {
  process.stderr.write(`[smoke-test] ${message}\n`)
}

function check(condition, message) {
  if (!condition) throw new Error(`smoke test failed: ${message}`)
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolvePort(port))
    })
  })
}

/** PIDs still in process group `pgid`. */
function groupMembers(pgid) {
  try {
    const out = execFileSync('ps', ['-A', '-o', 'pid=,pgid='], { encoding: 'utf-8' })
    return out.split('\n').map(l => l.trim().split(/\s+/).map(Number)).filter(([, g]) => g === pgid).map(([p]) => p)
  } catch {
    return []
  }
}

function killGroup(pgid) {
  try { process.kill(-pgid, 'SIGKILL') } catch { /* gone */ }
}

/** Start the launcher; resolve with the first event line (or null if it exited without one). */
function startLauncher({ nodeBin, payloadDir, env }) {
  const child = spawn(nodeBin, [join(payloadDir, 'bin', 'codekin.mjs'), 'app-server', '--credential-fd=3', '--lifetime-stdin'], {
    env,
    cwd: env.HOME,
    detached: true, // own process group, like the shell's process_group(0)
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let credential = ''
  child.stdout.on('data', d => { stdout += d })
  child.stderr.on('data', d => { stderr += d })
  child.stdio[3].on('data', d => { credential += d })
  const exited = new Promise(r => child.on('exit', (code, signal) => r({ code, signal })))
  const event = new Promise((resolveEvent) => {
    const timer = setTimeout(() => resolveEvent({ event: 'timeout' }), EVENT_TIMEOUT_MS)
    const scan = () => {
      const line = stdout.split('\n').find(l => l.startsWith('@@codekin '))
      if (line) { clearTimeout(timer); resolveEvent(JSON.parse(line.slice('@@codekin '.length))) }
    }
    child.stdout.on('data', scan)
    void exited.then(() => { scan(); clearTimeout(timer); resolveEvent(null) })
  })
  return { child, exited, event, output: () => ({ stdout, stderr, credential }) }
}

export async function runSmokeTest({ nodeBin, payloadDir }) {
  check(existsSync(nodeBin), `node binary ${nodeBin} not found`)
  check(existsSync(join(payloadDir, 'bin', 'codekin.mjs')), `payload ${payloadDir} has no bin/codekin.mjs`)
  const payloadVersion = JSON.parse(readFileSync(join(payloadDir, 'package.json'), 'utf-8')).version

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'codekin-smoke-')))
  const home = join(root, 'home')
  const dataDir = join(root, 'data')
  const configDir = join(home, '.config', 'codekin')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(join(root, 'repos'))
  // Nothing from the builder's environment: no AUTH_TOKEN, DATA_DIR, relay, NODE_ENV, PATH tools.
  const env = {
    HOME: home,
    PATH: '/usr/bin:/bin',
    SHELL: '/bin/sh',
    TMPDIR: root,
    CODEKIN_LOGIN_PATH: '0',
  }

  let launcher = null
  try {
    let started = null
    for (let attempt = 1; attempt <= MAX_PORT_ATTEMPTS && !started; attempt++) {
      const port = await freePort()
      writeFileSync(join(configDir, 'env'), `PORT=${port}\nDATA_DIR=${dataDir}\nREPOS_ROOT=${join(root, 'repos')}\n`)
      launcher = startLauncher({ nodeBin, payloadDir, env })
      const ev = await launcher.event
      if (ev?.event === 'bind_failed') {
        log(`port ${port} was taken (attempt ${attempt}); retrying`)
        await launcher.exited
        killGroup(launcher.child.pid)
        launcher = null
        continue
      }
      if (ev?.event !== 'started') {
        const { stdout, stderr } = launcher.output()
        throw new Error(`smoke test failed: expected a started event, got ${JSON.stringify(ev)}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`)
      }
      started = ev
    }
    check(started, 'no free port after retries')
    const { port } = started
    log(`started on 127.0.0.1:${port} (Codekin ${started.version})`)

    const cred = JSON.parse(launcher.output().credential)
    check(typeof cred.token === 'string' && cred.token.length >= 16, 'credential handoff on fd 3')
    check(cred.source === 'AUTH_TOKEN_FILE', `credential source ${cred.source}`)
    const base = `http://127.0.0.1:${port}`

    const ping = await (await fetch(`${base}/api/ping`)).json()
    check(ping.app === 'codekin' && ping.version === payloadVersion, `/api/ping returned ${JSON.stringify(ping)}`)
    check((await fetch(`${base}/api/health`)).status === 401, '/api/health without a token must be 401')
    const health = await fetch(`${base}/api/health`, { headers: { Authorization: `Bearer ${cred.token}` } })
    check(health.status === 200 && (await health.json()).status === 'ok', `authenticated /api/health returned ${health.status}`)
    const index = await fetch(`${base}/`)
    check(index.status === 200 && (await index.text()).includes('<div id="root">'), 'bundled frontend is served at /')

    check(existsSync(join(dataDir, '.codekin-owner.sqlite')), 'data-directory lock in the temporary DATA_DIR')
    check(existsSync(join(home, '.codekin', 'session-archive.db')), 'SQLite session archive opened in the temporary home')
    const { stdout, stderr } = launcher.output()
    check(!(stdout + stderr).includes(cred.token), 'token must not appear in stdout/stderr')

    // Clean shutdown through the lifetime pipe.
    const pgid = launcher.child.pid
    launcher.child.stdin.end()
    const exit = await Promise.race([
      launcher.exited,
      new Promise(r => setTimeout(() => r({ code: 'timeout' }), SHUTDOWN_TIMEOUT_MS)),
    ])
    check(exit.code === 0, `graceful shutdown exit ${JSON.stringify(exit)}`)
    check(groupMembers(pgid).length === 0, 'no processes left in the launcher process group')
    launcher = null
    log(`passed (${platform()}/${arch()})`)
  } finally {
    if (launcher) {
      launcher.child.stdin.destroy()
      killGroup(launcher.child.pid)
      await launcher.exited
    }
    rmSync(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const arg = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1] }
  const triple = { 'darwin-arm64': 'aarch64-apple-darwin', 'linux-x64': 'x86_64-unknown-linux-gnu', 'linux-arm64': 'aarch64-unknown-linux-gnu' }[`${platform()}-${arch()}`]
  const nodeBin = arg('--node') ?? join(DESKTOP_DIR, 'src-tauri', 'binaries', `node-${triple}`)
  const payloadDir = arg('--payload') ?? join(DESKTOP_DIR, 'build', 'codekin')
  try {
    await runSmokeTest({ nodeBin, payloadDir })
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
}
