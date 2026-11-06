/** Tests for the shared launcher (bin/lib/launch.mjs). Never touches the real ~/.config/codekin. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, mkdirSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServer } from 'http'
import {
  DEFAULT_PORT,
  buildServerEnv,
  configPaths,
  decideFromProbe,
  ensureCredential,
  fallbackPath,
  formatCredential,
  formatEvent,
  parseCredentialFd,
  parseDelimitedPath,
  probeServer,
  readEnvFile,
  resolveCredential,
  resolveLoginPath,
  resolvePort,
  resolveProbeHost,
  writeEnvFile,
} from './launch.mjs'

let home
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'codekin-launch-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe('env file', () => {
  it('round-trips and skips comments and blank lines', () => {
    const file = join(home, 'env')
    writeFileSync(file, '# comment\n\nPORT=4000\nURL=http://x/?a=b\nBROKEN\n')
    expect(readEnvFile(file)).toEqual({ PORT: '4000', URL: 'http://x/?a=b' })
    writeEnvFile(file, { A: '1', B: '2' })
    expect(readFileSync(file, 'utf-8')).toBe('A=1\nB=2\n')
  })

  it('treats a missing file as empty', () => {
    expect(readEnvFile(join(home, 'nope'))).toEqual({})
  })
})

describe('buildServerEnv', () => {
  it('loads the whole env file over the inherited environment', () => {
    const env = buildServerEnv({ baseEnv: { PORT: '1', HOME: '/h' }, fileVars: { PORT: '2', DATA_DIR: '/d' } })
    expect(env).toEqual({ PORT: '2', HOME: '/h', DATA_DIR: '/d' })
  })

  it('fills FRONTEND_DIST only when unset, unless forced', () => {
    const fileVars = { FRONTEND_DIST: '/npm/dist' }
    expect(buildServerEnv({ baseEnv: {}, fileVars, frontendDist: '/app/dist' }).FRONTEND_DIST).toBe('/npm/dist')
    expect(buildServerEnv({ baseEnv: {}, fileVars: {}, frontendDist: '/app/dist' }).FRONTEND_DIST).toBe('/app/dist')
    expect(buildServerEnv({ baseEnv: {}, fileVars, frontendDist: '/app/dist', forceFrontend: true }).FRONTEND_DIST).toBe('/app/dist')
  })
})

describe('resolvePort / resolveProbeHost', () => {
  it('defaults and rejects garbage ports', () => {
    expect(resolvePort({})).toBe(DEFAULT_PORT)
    expect(resolvePort({ PORT: '4100' })).toBe(4100)
    expect(resolvePort({ PORT: 'abc' })).toBe(DEFAULT_PORT)
    expect(resolvePort({ PORT: '70000' })).toBe(DEFAULT_PORT)
  })

  it('probes loopback for wildcard binds and the bind host otherwise', () => {
    expect(resolveProbeHost({})).toBe('127.0.0.1')
    expect(resolveProbeHost({ BIND_HOST: '0.0.0.0' })).toBe('127.0.0.1')
    expect(resolveProbeHost({ BIND_HOST: '::' })).toBe('127.0.0.1')
    expect(resolveProbeHost({ BIND_HOST: '192.168.1.5' })).toBe('192.168.1.5')
  })
})

describe('resolveCredential', () => {
  it('prefers AUTH_TOKEN over AUTH_TOKEN_FILE, like the server', () => {
    const file = join(home, 'tok')
    writeFileSync(file, 'from-file\n')
    expect(resolveCredential({ AUTH_TOKEN: 'from-env', AUTH_TOKEN_FILE: file })).toEqual({ ok: true, token: 'from-env', source: 'AUTH_TOKEN' })
    expect(resolveCredential({ AUTH_TOKEN: '', AUTH_TOKEN_FILE: file })).toEqual({ ok: true, token: 'from-file', source: 'AUTH_TOKEN_FILE' })
  })

  it('reports nothing configured', () => {
    expect(resolveCredential({})).toMatchObject({ ok: false, code: 'unconfigured' })
  })

  it('reports a configured but missing or empty file as unreadable, without the token', () => {
    expect(resolveCredential({ AUTH_TOKEN_FILE: join(home, 'missing') })).toMatchObject({ ok: false, code: 'unreadable', source: 'AUTH_TOKEN_FILE' })
    const empty = join(home, 'empty')
    writeFileSync(empty, '  \n')
    expect(resolveCredential({ AUTH_TOKEN_FILE: empty })).toMatchObject({ ok: false, code: 'unreadable' })
  })
})

describe('ensureCredential', () => {
  it('first launch: writes a 0600 token, AUTH_TOKEN_FILE and the default PORT', () => {
    const result = ensureCredential({ home, baseEnv: {} })
    expect(result).toEqual({ ok: true, created: true })
    const { tokenFile, envFile } = configPaths(home)
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600)
    expect(readFileSync(tokenFile, 'utf-8').trim()).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(readEnvFile(envFile)).toEqual({ AUTH_TOKEN_FILE: tokenFile, PORT: String(DEFAULT_PORT) })
  })

  it('keeps existing env-file settings and an existing default token', () => {
    const { configDir, tokenFile, envFile } = configPaths(home)
    mkdirSync(configDir, { recursive: true })
    writeFileSync(tokenFile, 'kept\n')
    writeFileSync(envFile, 'PORT=4000\nREPOS_ROOT=/r\n')
    expect(ensureCredential({ home, baseEnv: {} })).toEqual({ ok: true, created: false })
    expect(readFileSync(tokenFile, 'utf-8')).toBe('kept\n')
    expect(readEnvFile(envFile)).toEqual({ PORT: '4000', REPOS_ROOT: '/r', AUTH_TOKEN_FILE: tokenFile })
  })

  it('reuses an inherited AUTH_TOKEN or a custom AUTH_TOKEN_FILE without writing anything', () => {
    const { tokenFile, envFile } = configPaths(home)
    expect(ensureCredential({ home, baseEnv: { AUTH_TOKEN: 'x' } })).toEqual({ ok: true, created: false })
    const custom = join(home, 'custom-token')
    writeFileSync(custom, 'custom\n')
    expect(ensureCredential({ home, baseEnv: { AUTH_TOKEN_FILE: custom } })).toEqual({ ok: true, created: false })
    expect(() => statSync(tokenFile)).toThrow()
    expect(() => statSync(envFile)).toThrow()
  })

  it('refuses to replace a configured but unreadable token file', () => {
    const { configDir, tokenFile, envFile } = configPaths(home)
    mkdirSync(configDir, { recursive: true })
    const custom = join(home, 'gone')
    writeFileSync(envFile, `AUTH_TOKEN_FILE=${custom}\n`)
    const result = ensureCredential({ home, baseEnv: {} })
    expect(result).toMatchObject({ ok: false, code: 'unreadable' })
    expect(() => statSync(tokenFile)).toThrow()
    expect(readFileSync(envFile, 'utf-8')).toBe(`AUTH_TOKEN_FILE=${custom}\n`)
  })
})

describe('login-shell PATH', () => {
  it('extracts only the delimited value, ignoring banners', () => {
    const out = 'Welcome!\n__CODEKIN_PATH_BEGIN__/opt/homebrew/bin:/usr/bin__CODEKIN_PATH_END__'
    expect(parseDelimitedPath(out)).toBe('/opt/homebrew/bin:/usr/bin')
    expect(parseDelimitedPath('no markers')).toBeNull()
    expect(parseDelimitedPath('__CODEKIN_PATH_BEGIN____CODEKIN_PATH_END__')).toBeNull()
  })

  it('falls back with home expanded and without duplicates', () => {
    expect(fallbackPath('/usr/bin:/usr/local/bin', '/Users/a')).toBe('/opt/homebrew/bin:/Users/a/.local/bin:/usr/bin:/usr/local/bin')
  })

  it('uses the login shell, or the fallback with a warning when it fails', () => {
    const ok = resolveLoginPath({
      shell: '/bin/zsh', inheritedPath: '/usr/bin', home: '/Users/a',
      exec: () => 'motd\n__CODEKIN_PATH_BEGIN__/a:/b__CODEKIN_PATH_END__',
    })
    expect(ok).toEqual({ path: '/a:/b', source: 'login-shell' })
    const failed = resolveLoginPath({
      shell: '/bin/zsh', inheritedPath: '/usr/bin', home: '/Users/a',
      exec: () => { throw Object.assign(new Error('t'), { code: 'ETIMEDOUT' }) },
    })
    expect(failed.source).toBe('fallback')
    expect(failed.warning).toContain('ETIMEDOUT')
    expect(failed.path.startsWith('/opt/homebrew/bin:')).toBe(true)
  })

  it('works against a real POSIX shell', () => {
    const shell = join(home, 'sh')
    writeFileSync(shell, '#!/bin/sh\necho banner\nexec /bin/sh -c "$2"\n')
    chmodSync(shell, 0o755)
    const r = resolveLoginPath({ shell, inheritedPath: '/x', home })
    expect(r.source).toBe('login-shell')
    expect(r.path).toBe(process.env.PATH)
  })
})

describe('probeServer / decideFromProbe', () => {
  let server
  let port
  let handler

  beforeEach(async () => {
    handler = () => {}
    server = createServer((req, res) => handler(req, res))
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    port = server.address().port
  })
  afterEach(async () => { await new Promise(r => server.close(r)) })

  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
  const codekin = (expected) => (req, res) => {
    if (req.url === '/api/ping') return json(res, 200, { app: 'codekin', version: '1.2.3' })
    if (req.url === '/api/health') {
      return req.headers.authorization === `Bearer ${expected}` ? json(res, 200, { status: 'ok' }) : json(res, 401, { error: 'Unauthorized' })
    }
    json(res, 404, {})
  }

  it('attaches to Codekin with a valid token', async () => {
    handler = codekin('good')
    const probe = await probeServer({ host: '127.0.0.1', port, token: 'good' })
    expect(probe).toEqual({ state: 'codekin', version: '1.2.3', auth: 'ok' })
    expect(decideFromProbe(probe)).toBe('attach')
  })

  it('reports auth_error when Codekin rejects the token', async () => {
    handler = codekin('good')
    const probe = await probeServer({ host: '127.0.0.1', port, token: 'bad' })
    expect(decideFromProbe(probe)).toBe('auth_error')
  })

  it('never sends the token to a server whose ping is not Codekin', async () => {
    const seen = []
    handler = (req, res) => { seen.push(req.headers.authorization); json(res, 200, { app: 'other' }) }
    const probe = await probeServer({ host: '127.0.0.1', port, token: 'secret' })
    expect(decideFromProbe(probe)).toBe('port_conflict')
    expect(seen).toEqual([undefined])
  })

  it('treats a Codekin release without /api/ping (401) as a port conflict', async () => {
    handler = (_req, res) => json(res, 401, { error: 'Unauthorized' })
    expect(decideFromProbe(await probeServer({ host: '127.0.0.1', port, token: 't' }))).toBe('port_conflict')
  })

  it('does not follow redirects', async () => {
    handler = (_req, res) => { res.writeHead(302, { Location: 'http://example.com/' }); res.end() }
    expect((await probeServer({ host: '127.0.0.1', port, token: 't' })).state).toBe('foreign')
  })

  it('treats a timeout as unresponsive, never as a free port', async () => {
    handler = () => { /* never answers */ }
    const probe = await probeServer({ host: '127.0.0.1', port, token: 't', timeoutMs: 100 })
    expect(probe).toEqual({ state: 'unresponsive' })
    expect(decideFromProbe(probe)).toBe('unresponsive')
  })

  it('starts only when the connection is refused', async () => {
    await new Promise(r => server.close(r))
    const probe = await probeServer({ host: '127.0.0.1', port, token: 't' })
    expect(probe).toEqual({ state: 'refused' })
    expect(decideFromProbe(probe)).toBe('start')
    server = createServer()
    await new Promise(r => server.listen(0, '127.0.0.1', r))
  })
})

describe('events and the credential handoff', () => {
  it('writes only known fields, so a token cannot reach stdout', () => {
    const line = formatEvent('attach', { port: 1, version: '1.0.0', token: 'secret', reason: 'x' })
    expect(line).toBe('@@codekin {"event":"attach","port":1,"version":"1.0.0","reason":"x"}\n')
    expect(line).not.toContain('secret')
  })

  it('parses --credential-fd and rejects stdio fds', () => {
    expect(parseCredentialFd([])).toBeNull()
    expect(parseCredentialFd(['--credential-fd=3'])).toBe(3)
    expect(parseCredentialFd(['--credential-fd', '4'])).toBe(4)
    expect(() => parseCredentialFd(['--credential-fd=1'])).toThrow()
    expect(() => parseCredentialFd(['--credential-fd=x'])).toThrow()
  })

  it('formats the handoff as one JSON line', () => {
    expect(formatCredential({ token: 't', source: 'AUTH_TOKEN' })).toBe('{"token":"t","source":"AUTH_TOKEN"}\n')
  })
})
