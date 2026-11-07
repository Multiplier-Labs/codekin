/** Tests for the payload builder's checks (desktop/scripts/bundle-server.mjs). No network, no real build. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  DESKTOP_DIR,
  REPO_ROOT,
  TARGETS,
  assertHostMatches,
  nativeAddonPlan,
  codesignArgs,
  assertLockfileMatches,
  fetchNode,
  parseArgs,
  pinnedNodeEnv,
  readRuntimePin,
  withoutNpmEnv,
} from './bundle-server.mjs'

let dir
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'codekin-bundle-test-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const sha = (buf) => createHash('sha256').update(buf).digest('hex')

describe('parseArgs', () => {
  it('defaults to darwin-arm64 with the smoke test', () => {
    expect(parseArgs([])).toEqual({ target: 'darwin-arm64', smokeTest: true })
  })
  it('accepts a target and skipping the smoke test', () => {
    expect(parseArgs(['--target', 'linux-x64', '--skip-smoke-test'])).toEqual({ target: 'linux-x64', smokeTest: false })
    expect(parseArgs(['--target=linux-arm64']).target).toBe('linux-arm64')
  })
  it('rejects unknown targets and arguments', () => {
    expect(() => parseArgs(['--target', 'win32-x64'])).toThrow(/Unsupported target/)
    expect(() => parseArgs(['--fast'])).toThrow(/Unknown argument/)
  })
})

describe('assertHostMatches', () => {
  it('refuses to build a target the host cannot run (no accidental Intel or Linux payload)', () => {
    expect(() => assertHostMatches('darwin-arm64', { platform: 'darwin', arch: 'arm64' })).not.toThrow()
    expect(() => assertHostMatches('darwin-arm64', { platform: 'darwin', arch: 'x64' })).toThrow(/darwin\/arm64/)
    expect(() => assertHostMatches('darwin-arm64', { platform: 'linux', arch: 'arm64' })).toThrow()
  })
  it('maps every target to a Rust triple', () => {
    expect(TARGETS['darwin-arm64'].triple).toBe('aarch64-apple-darwin')
  })
})

describe('readRuntimePin', () => {
  it('reads the committed pin with a checksum for every target', () => {
    const pin = readRuntimePin()
    for (const target of Object.keys(TARGETS)) expect(pin.sha256[target]).toMatch(/^[0-9a-f]{64}$/)
  })
  it('rejects a malformed pin', () => {
    const f = join(dir, 'pin.json')
    writeFileSync(f, JSON.stringify({ version: '24', sha256: {} }))
    expect(() => readRuntimePin(f)).toThrow(/x\.y\.z/)
    writeFileSync(f, JSON.stringify({ version: '24.1.0', sha256: { 'linux-x64': 'abc' } }))
    expect(() => readRuntimePin(f)).toThrow(/SHA-256/)
  })
})

describe('assertLockfileMatches', () => {
  it('accepts the repository lockfile', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'))
    const lock = JSON.parse(readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf-8'))
    expect(() => assertLockfileMatches(pkg, lock)).not.toThrow()
  })
  it('rejects a lockfile for another version', () => {
    expect(() => assertLockfileMatches({ name: 'codekin', version: '1.0.0' }, { name: 'codekin', version: '0.9.0', packages: { '': {} } })).toThrow(/0\.9\.0/)
    expect(() => assertLockfileMatches({ name: 'codekin', version: '1.0.0' }, { name: 'codekin', version: '1.0.0' })).toThrow(/root package/)
  })
})

describe('fetchNode', () => {
  const body = Buffer.from('fake node tarball')
  const pin = { version: '24.0.0', sha256: { 'linux-x64': sha(body) } }
  const okFetch = (calls) => async (url) => { calls.push(url); return { ok: true, arrayBuffer: async () => body } }

  it('downloads once, verifies, and reuses the verified cache', async () => {
    const calls = []
    const file = await fetchNode(pin, 'linux-x64', { cacheDir: dir, fetchImpl: okFetch(calls) })
    expect(calls).toEqual(['https://nodejs.org/dist/v24.0.0/node-v24.0.0-linux-x64.tar.gz'])
    await fetchNode(pin, 'linux-x64', { cacheDir: dir, fetchImpl: okFetch(calls) })
    expect(calls).toHaveLength(1)
    expect(readFileSync(file)).toEqual(body)
  })

  it('rejects and deletes a download whose checksum does not match', async () => {
    const bad = { ...pin, sha256: { 'linux-x64': '0'.repeat(64) } }
    await expect(fetchNode(bad, 'linux-x64', { cacheDir: dir, fetchImpl: okFetch([]) })).rejects.toThrow(/does not match/)
    expect(existsSync(join(dir, 'node-v24.0.0-linux-x64.tar.gz'))).toBe(false)
  })

  it('re-verifies a cached file instead of trusting it', async () => {
    writeFileSync(join(dir, 'node-v24.0.0-linux-x64.tar.gz'), 'tampered')
    await expect(fetchNode(pin, 'linux-x64', { cacheDir: dir, fetchImpl: okFetch([]) })).rejects.toThrow(/does not match/)
  })

  it('fails on HTTP errors and on targets without a pinned checksum', async () => {
    await expect(fetchNode(pin, 'linux-x64', { cacheDir: dir, fetchImpl: async () => ({ ok: false, status: 404 }) })).rejects.toThrow(/HTTP 404/)
    await expect(fetchNode(pin, 'darwin-arm64', { cacheDir: dir, fetchImpl: okFetch([]) })).rejects.toThrow(/no sha256/)
  })
})

describe('npm environment', () => {
  it('drops npm_* variables from an outer npm run', () => {
    expect(withoutNpmEnv({ PATH: '/bin', npm_config_prefix: '/x', NPM_TOKEN: 't', HOME: '/h' })).toEqual({ PATH: '/bin', HOME: '/h' })
  })
  it('puts the pinned Node first on PATH for a production install', () => {
    const env = pinnedNodeEnv('/pinned/bin', { PATH: '/usr/bin', NODE_ENV: 'development', npm_execpath: '/x' })
    expect(env).toEqual({ PATH: '/pinned/bin:/usr/bin', NODE_ENV: 'production' })
  })
})

it('keeps generated output out of git', () => {
  const ignore = readFileSync(join(DESKTOP_DIR, '.gitignore'), 'utf-8')
  for (const entry of ['/build/', '/.cache/', '/src-tauri/binaries/']) expect(ignore).toContain(entry)
})

describe('nativeAddonPlan', () => {
  const files = [
    'node_modules/better-sqlite3/prebuilds/darwin-arm64.node',
    'node_modules/better-sqlite3/prebuilds/darwin-x64.node',
    'node_modules/better-sqlite3/prebuilds/linux-x64.node',
    'node_modules/better-sqlite3/prebuilds/linuxmusl-x64.node',
    'node_modules/better-sqlite3/prebuilds/win32-x64.node',
    'node_modules/other/build/Release/addon.node',
  ]

  it('on macOS keeps and re-signs only what this Mac can load', () => {
    expect(nativeAddonPlan(files, 'darwin-arm64')).toEqual({
      remove: files.slice(1, 5),
      sign: ['node_modules/better-sqlite3/prebuilds/darwin-arm64.node', 'node_modules/other/build/Release/addon.node'],
    })
  })

  it('on Linux prunes other platforms and signs nothing', () => {
    const plan = nativeAddonPlan(files, 'linux-x64')
    expect(plan.sign).toEqual([])
    expect(plan.remove).not.toContain('node_modules/better-sqlite3/prebuilds/linux-x64.node')
    expect(plan.remove).toContain('node_modules/better-sqlite3/prebuilds/linuxmusl-x64.node')
  })
})

describe('codesignArgs', () => {
  it('signs ad-hoc without an identity', () => {
    expect(codesignArgs('', 'a.node')).toEqual(['--force', '--sign', '-', 'a.node'])
  })

  it('signs for notarization with a Developer ID', () => {
    const id = 'Developer ID Application: Multiplier Labs (ABCDE12345)'
    expect(codesignArgs(id, 'a.node')).toEqual(['--force', '--options', 'runtime', '--timestamp', '--sign', id, 'a.node'])
  })
})
