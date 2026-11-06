/**
 * Integration tests for `codekin app-server`: each runs the real CLI in a
 * child process with a temporary HOME, data directory and port, against a
 * fake server or the compiled real one. Nothing reads or writes the real
 * ~/.config/codekin or attaches to a running Codekin.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createServer } from 'http'
import { createServer as createNetServer } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { PACKAGE_ROOT } from './launch.mjs'

const CLI = join(PACKAGE_ROOT, 'bin', 'codekin.mjs')
const HAS_COMPILED_SERVER = existsSync(join(PACKAGE_ROOT, 'server', 'dist', 'ws-server.js'))

let root
let home
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codekin-app-server-'))
  home = join(root, 'home')
  mkdirSync(join(home, '.config', 'codekin'), { recursive: true })
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createNetServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

function writeEnv(vars) {
  const lines = Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n')
  writeFileSync(join(home, '.config', 'codekin', 'env'), lines + '\n')
}

function cleanEnv(extra = {}) {
  const env = { PATH: process.env.PATH, HOME: home, SHELL: '/bin/sh', CODEKIN_LOGIN_PATH: '0', ...extra }
  return env
}

/**
 * Spawn the launcher with a credential pipe on fd 3 and stdin as the
 * lifetime pipe. Resolves at the first event (or exit) with what was seen.
 */
function launch(env) {
  const child = spawn(process.execPath, [CLI, 'app-server', '--credential-fd=3', '--lifetime-stdin'], {
    env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let credential = ''
  child.stdout.on('data', d => { stdout += d })
  child.stderr.on('data', d => { stderr += d })
  child.stdio[3].on('data', d => { credential += d })
  // stdin stays open: EOF on it means "parent died" and stops the launcher.
  const exited = new Promise(resolve => child.on('exit', (code, signal) => { child.stdin.destroy(); resolve({ code, signal }) }))
  const firstEvent = new Promise((resolve) => {
    const check = () => {
      const line = stdout.split('\n').find(l => l.startsWith('@@codekin '))
      if (line) resolve(JSON.parse(line.slice('@@codekin '.length)))
    }
    child.stdout.on('data', check)
    void exited.then(() => { check(); resolve(null) })
  })
  return {
    child, exited, firstEvent,
    output: () => ({ stdout, stderr, credential }),
  }
}

async function fakeServer(handler) {
  const server = createServer(handler)
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return { server, port: server.address().port, close: () => new Promise(r => server.close(r)) }
}

const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
const fakeCodekin = (token) => (req, res) => {
  if (req.url === '/api/ping') return json(res, 200, { app: 'codekin', version: '9.9.9' })
  if (req.url === '/api/health') return req.headers.authorization === `Bearer ${token}` ? json(res, 200, { status: 'ok' }) : json(res, 401, {})
  json(res, 404, {})
}

describe('codekin app-server', () => {
  it('attaches to a Codekin server that accepts the credential, handing the token over fd 3 only', async () => {
    const fake = await fakeServer(fakeCodekin('tok-123'))
    try {
      writeEnv({ PORT: fake.port, AUTH_TOKEN: 'tok-123' })
      const run = launch(cleanEnv())
      expect(await run.firstEvent).toEqual({ event: 'attach', port: fake.port, host: '127.0.0.1', version: '9.9.9' })
      expect((await run.exited).code).toBe(0)
      const { stdout, stderr, credential } = run.output()
      expect(JSON.parse(credential)).toEqual({ token: 'tok-123', source: 'AUTH_TOKEN' })
      expect(stdout + stderr).not.toContain('tok-123')
    } finally { await fake.close() }
  })

  it('reports auth_error for a Codekin server that rejects the credential, without replacing it', async () => {
    const fake = await fakeServer(fakeCodekin('other'))
    try {
      const tokenFile = join(root, 'custom-token')
      writeFileSync(tokenFile, 'mine\n')
      writeEnv({ PORT: fake.port, AUTH_TOKEN_FILE: tokenFile })
      const run = launch(cleanEnv())
      expect(await run.firstEvent).toMatchObject({ event: 'auth_error', port: fake.port, source: 'AUTH_TOKEN_FILE' })
      expect((await run.exited).code).toBe(3)
      expect(readFileSync(tokenFile, 'utf-8')).toBe('mine\n')
      expect(run.output().stdout + run.output().stderr).not.toContain('mine')
    } finally { await fake.close() }
  })

  it('reports port_conflict for something that is not Codekin (or predates /api/ping)', async () => {
    const fake = await fakeServer((_req, res) => json(res, 401, { error: 'Unauthorized' }))
    try {
      writeEnv({ PORT: fake.port, AUTH_TOKEN: 't' })
      const run = launch(cleanEnv())
      expect(await run.firstEvent).toMatchObject({ event: 'port_conflict', port: fake.port })
      expect((await run.exited).code).toBe(4)
    } finally { await fake.close() }
  })

  it('reports config_error for a configured but missing token file and leaves the env file alone', async () => {
    const envBody = `PORT=1\nAUTH_TOKEN_FILE=${join(root, 'missing')}\n`
    writeFileSync(join(home, '.config', 'codekin', 'env'), envBody)
    const run = launch(cleanEnv())
    expect(await run.firstEvent).toMatchObject({ event: 'config_error', source: 'AUTH_TOKEN_FILE' })
    expect((await run.exited).code).toBe(2)
    expect(readFileSync(join(home, '.config', 'codekin', 'env'), 'utf-8')).toBe(envBody)
    expect(existsSync(join(home, '.config', 'codekin', 'token'))).toBe(false)
  })

  it.skipIf(!HAS_COMPILED_SERVER)('first launch starts the bundled server, a second launcher attaches, stdin EOF stops it', async () => {
    const port = await freePort()
    const dataDir = join(root, 'data')
    writeEnv({ PORT: port, DATA_DIR: dataDir, REPOS_ROOT: join(root, 'repos') })
    const env = cleanEnv({ CODEKIN_AUTO_RESTORE_SESSIONS: 'false' })

    const owner = launch(env)
    try {
      expect(await owner.firstEvent).toMatchObject({ event: 'started', port, host: '127.0.0.1' })
      const { token } = JSON.parse(owner.output().credential)
      expect(readFileSync(join(home, '.config', 'codekin', 'token'), 'utf-8').trim()).toBe(token)
      expect(existsSync(dataDir)).toBe(true)

      const second = launch(env)
      expect(await second.firstEvent).toMatchObject({ event: 'attach', port })
      expect((await second.exited).code).toBe(0)

      const ping = await (await fetch(`http://127.0.0.1:${port}/api/ping`)).json()
      expect(ping.app).toBe('codekin')
      const { stdout, stderr } = owner.output()
      expect(stdout + stderr).not.toContain(token)
    } finally {
      owner.child.stdin.end()
    }
    const exit = await owner.exited
    expect(exit.code).toBe(0)
    expect(owner.output().stderr).toContain('stdin closed')
  }, 60_000)
})
