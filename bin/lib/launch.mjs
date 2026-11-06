/**
 * Shared launcher: the setup, environment and start logic used by
 * `codekin setup`, `codekin start`, the service units and the desktop app's
 * hidden `codekin app-server` entry point.
 *
 * Spec: docs/DESKTOP-APP-TAURI-PLAN.md ("Launcher (D1)"). Everything here is
 * plain functions with explicit inputs (home directory, env, file paths), so
 * the CLI and the app agree on one contract and tests never touch the real
 * ~/.config/codekin.
 */

import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir as osHomedir } from 'os'
import { join, dirname, delimiter } from 'path'
import { fileURLToPath } from 'url'
import { randomBytes } from 'crypto'

export const DEFAULT_PORT = 32352

/** Root of the installed package (the directory holding package.json). */
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// ---------------------------------------------------------------------------
// Config locations and the env file
// ---------------------------------------------------------------------------

/** Config file locations for a given home directory. */
export function configPaths(home = osHomedir()) {
  const configDir = join(home, '.config', 'codekin')
  return {
    configDir,
    tokenFile: join(configDir, 'token'),
    envFile: join(configDir, 'env'),
  }
}

/** Parse `KEY=value` lines; blank lines and `#` comments are skipped. Missing file → `{}`. */
export function readEnvFile(envFile) {
  if (!existsSync(envFile)) return {}
  const vars = {}
  for (const line of readFileSync(envFile, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    vars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
  }
  return vars
}

export function writeEnvFile(envFile, vars) {
  const lines = Object.entries(vars).map(([k, v]) => `${k}=${v}`)
  writeFileSync(envFile, lines.join('\n') + '\n')
}

/** The port the server will use: env `PORT`, else the default. */
export function resolvePort(env) {
  const port = parseInt(env.PORT || String(DEFAULT_PORT), 10)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT
}

/**
 * The host a local client should use to reach the server. The server binds to
 * `BIND_HOST` (default loopback); a wildcard bind is reached via loopback.
 */
export function resolveProbeHost(env) {
  const bind = env.BIND_HOST || '127.0.0.1'
  if (bind === '0.0.0.0' || bind === '::' || bind === '') return '127.0.0.1'
  return bind
}

// ---------------------------------------------------------------------------
// Package files
// ---------------------------------------------------------------------------

/** The server entry point: compiled JS, or the TypeScript source run through tsx in a dev checkout. */
export function findServerScript(packageRoot = PACKAGE_ROOT) {
  const compiled = join(packageRoot, 'server', 'dist', 'ws-server.js')
  if (existsSync(compiled)) return { script: compiled, runner: process.execPath, compiled: true }
  const ts = join(packageRoot, 'server', 'ws-server.ts')
  if (existsSync(ts)) return { script: ts, runner: 'tsx', compiled: false }
  throw new Error('Server script not found. Run npm run build first.')
}

export function findFrontendDist(packageRoot = PACKAGE_ROOT) {
  const dist = join(packageRoot, 'dist')
  return existsSync(dist) ? dist : null
}

// ---------------------------------------------------------------------------
// Server environment
// ---------------------------------------------------------------------------

/**
 * The environment the server runs with: the inherited environment with the
 * **whole** env file loaded over it (as `codekin start` has always done).
 *
 * `frontendDist` fills `FRONTEND_DIST` when nothing set it; with
 * `forceFrontend` it always wins (the desktop app serves its bundled `dist/`,
 * whatever an npm install wrote into the env file).
 */
export function buildServerEnv({ baseEnv, fileVars, frontendDist = null, forceFrontend = false }) {
  const env = { ...baseEnv, ...fileVars }
  if (frontendDist && (forceFrontend || !env.FRONTEND_DIST)) env.FRONTEND_DIST = frontendDist
  return env
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * Resolve the effective auth token exactly as the server does
 * (`loadAuthToken` in server/config.ts): a non-empty `AUTH_TOKEN` first,
 * otherwise the contents of `AUTH_TOKEN_FILE`.
 *
 * Unlike the server, an `AUTH_TOKEN_FILE` that is configured but missing,
 * unreadable or empty is reported as a configuration error instead of
 * resolving to "no token", so callers never mistake it for permission to
 * generate a replacement. Results never include the token in `reason`.
 *
 * @returns `{ ok: true, token, source }` | `{ ok: false, code, reason, source }`
 *   where `source` is `'AUTH_TOKEN'`, `'AUTH_TOKEN_FILE'` or `null` and `code`
 *   is `'unconfigured'` or `'unreadable'`.
 */
export function resolveCredential(env) {
  if (env.AUTH_TOKEN) return { ok: true, token: env.AUTH_TOKEN, source: 'AUTH_TOKEN' }
  const file = env.AUTH_TOKEN_FILE || ''
  if (!file) return { ok: false, code: 'unconfigured', reason: 'Neither AUTH_TOKEN nor AUTH_TOKEN_FILE is set', source: null }
  let token
  try {
    token = readFileSync(file, 'utf-8').trim()
  } catch (err) {
    const why = err && typeof err === 'object' && 'code' in err ? err.code : 'read failed'
    return { ok: false, code: 'unreadable', reason: `AUTH_TOKEN_FILE ${file} can't be read (${why})`, source: 'AUTH_TOKEN_FILE' }
  }
  if (!token) return { ok: false, code: 'unreadable', reason: `AUTH_TOKEN_FILE ${file} is empty`, source: 'AUTH_TOKEN_FILE' }
  return { ok: true, token, source: 'AUTH_TOKEN_FILE' }
}

export function generateToken() {
  return randomBytes(16).toString('base64url')
}

/**
 * Make sure a credential is configured, for first launch of the app.
 *
 * Reuses whatever already resolves (an inherited or env-file `AUTH_TOKEN`, a
 * custom `AUTH_TOKEN_FILE`). Only when **no** credential is configured does it
 * create the default token file (`0600`, reusing an existing one) and point
 * `AUTH_TOKEN_FILE` at it in the env file, which also gets the default `PORT`
 * if it has none. A configured but unreadable credential is returned as an
 * error and left untouched.
 *
 * @returns `{ ok: true, created: boolean }` | the failed `resolveCredential` result.
 */
export function ensureCredential({ home = osHomedir(), baseEnv }) {
  const { configDir, tokenFile, envFile } = configPaths(home)
  mkdirSync(configDir, { recursive: true })
  const fileVars = readEnvFile(envFile)
  const current = resolveCredential({ ...baseEnv, ...fileVars })
  if (current.ok) return { ok: true, created: false }
  if (current.code !== 'unconfigured') return current

  let created = false
  if (!existsSync(tokenFile)) {
    writeFileSync(tokenFile, generateToken() + '\n', { mode: 0o600 })
    created = true
  }
  const next = { ...fileVars, AUTH_TOKEN_FILE: tokenFile }
  if (!next.PORT) next.PORT = String(DEFAULT_PORT)
  writeEnvFile(envFile, next)
  return { ok: true, created }
}

// ---------------------------------------------------------------------------
// Login-shell PATH (GUI apps inherit launchd's minimal PATH)
// ---------------------------------------------------------------------------

const PATH_BEGIN = '__CODEKIN_PATH_BEGIN__'
const PATH_END = '__CODEKIN_PATH_END__'

/** Extract the delimited PATH from login-shell output; banners and motd around it are ignored. */
export function parseDelimitedPath(output) {
  const start = output.lastIndexOf(PATH_BEGIN)
  if (start === -1) return null
  const end = output.indexOf(PATH_END, start + PATH_BEGIN.length)
  if (end === -1) return null
  const value = output.slice(start + PATH_BEGIN.length, end).trim()
  return value || null
}

/** Inherited PATH with the usual user-level bin directories prepended (home expanded, no literal `~`). */
export function fallbackPath(inheritedPath, home) {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', join(home, '.local', 'bin')]
  const parts = (inheritedPath || '').split(delimiter).filter(Boolean)
  return [...extra.filter(p => !parts.includes(p)), ...parts].join(delimiter)
}

/**
 * The user's login-shell PATH: `$SHELL -ilc` prints it between unique
 * delimiters, with a 5 s timeout. Falls back to {@link fallbackPath} and
 * reports `warning` when the shell fails or prints nothing usable.
 *
 * @returns `{ path, source: 'login-shell' | 'fallback', warning? }`
 */
export function resolveLoginPath({ shell, inheritedPath, home = osHomedir(), timeoutMs = 5000, exec = execFileSync }) {
  const sh = shell || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
  try {
    const out = exec(sh, ['-ilc', `printf '%s%s%s' '${PATH_BEGIN}' "$PATH" '${PATH_END}'`], {
      encoding: 'utf-8',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const path = parseDelimitedPath(String(out))
    if (path) return { path, source: 'login-shell' }
    return { path: fallbackPath(inheritedPath, home), source: 'fallback', warning: `${sh} printed no PATH` }
  } catch (err) {
    const why = err && typeof err === 'object' && 'code' in err && err.code ? err.code : 'failed'
    return { path: fallbackPath(inheritedPath, home), source: 'fallback', warning: `${sh} -ilc ${why}` }
  }
}

// ---------------------------------------------------------------------------
// Probing a port
// ---------------------------------------------------------------------------

function errorCode(err) {
  let e = err
  for (let i = 0; i < 4 && e; i++) {
    if (typeof e === 'object' && 'code' in e && typeof e.code === 'string') return e.code
    e = e.cause
  }
  return null
}

/**
 * What answers on `host:port`, judged by the unauthenticated `/api/ping` and
 * then the authenticated `/api/health`. The token goes only to a server whose
 * ping identified it as Codekin, and redirects are never followed.
 *
 * @returns one of
 *   - `{ state: 'refused' }`: nothing listening
 *   - `{ state: 'unresponsive' }`: a timeout or other network failure (not evidence the port is free)
 *   - `{ state: 'foreign' }`: something answered but its ping isn't Codekin (another app, or a Codekin release without `/api/ping`)
 *   - `{ state: 'codekin', version, auth: 'ok' | 'rejected' | 'unknown' }`
 */
export async function probeServer({ host, port, token, timeoutMs = 2000, fetchImpl = fetch }) {
  const base = `http://${host.includes(':') ? `[${host}]` : host}:${port}`
  let ping
  try {
    const res = await fetchImpl(`${base}/api/ping`, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
    if (res.status !== 200) return { state: 'foreign' }
    ping = await res.json().catch(() => null)
  } catch (err) {
    return { state: errorCode(err) === 'ECONNREFUSED' ? 'refused' : 'unresponsive' }
  }
  if (!ping || ping.app !== 'codekin' || typeof ping.version !== 'string') return { state: 'foreign' }

  const version = ping.version
  if (!token) return { state: 'codekin', version, auth: 'unknown' }
  try {
    const res = await fetchImpl(`${base}/api/health`, {
      redirect: 'manual',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status === 200) return { state: 'codekin', version, auth: 'ok' }
    if (res.status === 401 || res.status === 403) return { state: 'codekin', version, auth: 'rejected' }
    return { state: 'codekin', version, auth: 'unknown' }
  } catch {
    return { state: 'codekin', version, auth: 'unknown' }
  }
}

/**
 * Map a probe result to the launcher's decision. `start` is only returned for
 * a refused connection: a timeout never counts as a free port.
 */
export function decideFromProbe(probe) {
  switch (probe.state) {
    case 'refused': return 'start'
    case 'unresponsive': return 'unresponsive'
    case 'foreign': return 'port_conflict'
    case 'codekin':
      if (probe.auth === 'ok') return 'attach'
      if (probe.auth === 'rejected') return 'auth_error'
      return 'unresponsive'
    default: return 'unresponsive'
  }
}

// ---------------------------------------------------------------------------
// Launcher events and the private credential handoff
// ---------------------------------------------------------------------------

export const EVENT_PREFIX = '@@codekin '

/**
 * One event line for the desktop shell. Only known, non-secret fields are
 * written; anything else in `fields` is dropped, so a token can't slip into
 * stdout (which goes to the log file).
 */
const EVENT_FIELDS = ['port', 'host', 'version', 'source', 'reason', 'pathSource', 'dir', 'writerVersion']
export function formatEvent(event, fields = {}) {
  const out = { event }
  for (const key of EVENT_FIELDS) {
    if (fields[key] !== undefined) out[key] = fields[key]
  }
  return EVENT_PREFIX + JSON.stringify(out) + '\n'
}

/** Parse `--credential-fd=N` / `--credential-fd N`. Returns the fd, or null. */
export function parseCredentialFd(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    let v = null
    if (a.startsWith('--credential-fd=')) v = a.slice('--credential-fd='.length)
    else if (a === '--credential-fd') v = argv[i + 1]
    if (v !== null && v !== undefined) {
      const fd = Number(v)
      if (Number.isInteger(fd) && fd > 2) return fd
      throw new Error('--credential-fd must be a file descriptor above 2')
    }
  }
  return null
}

/** The credential handoff payload: one JSON line, `{ token, source }`. */
export function formatCredential(credential) {
  return JSON.stringify({ token: credential.token, source: credential.source }) + '\n'
}
