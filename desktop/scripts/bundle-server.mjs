#!/usr/bin/env node
/**
 * Build the server payload for Codekin.app (docs/DESKTOP-APP-TAURI-PLAN.md,
 * "Bundled payload").
 *
 *   1. `npm pack` the already-built repository: the app ships exactly the
 *      files the npm package does.
 *   2. Unpack into desktop/build/codekin/ and copy in the repository's
 *      package-lock.json from the same commit (npm leaves it out of packs).
 *   3. Download the pinned Node runtime (desktop/node-runtime.json), verify
 *      its SHA-256, and run `npm ci --omit=dev` with that Node and its own npm
 *      first on PATH, then load better-sqlite3 (a Node-API module with
 *      prebuilt binaries in its package) under that Node. A missing or
 *      out-of-sync lockfile fails the build.
 *   4. Place the Node binary as the Tauri sidecar
 *      (src-tauri/binaries/node-<target-triple>).
 *   5. Run the isolated smoke test (scripts/smoke-test.mjs) against the result.
 *
 * Usage: node scripts/bundle-server.mjs [--target darwin-arm64|linux-x64|linux-arm64] [--skip-smoke-test]
 *
 * The target defaults to darwin-arm64, the only app target in v1. The target
 * must match the build host: native dependencies are installed by running the
 * pinned Node, which can't run on another platform. linux-* targets exist so
 * the payload and smoke test can be checked on a Linux machine.
 */

import { execFileSync, spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { chmodSync, copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { arch as hostArch, platform as hostPlatform, tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

export const DESKTOP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const REPO_ROOT = resolve(DESKTOP_DIR, '..')

/** Supported targets: Node's dist name ↔ Rust target triple used for the sidecar file name. */
export const TARGETS = {
  'darwin-arm64': { platform: 'darwin', arch: 'arm64', triple: 'aarch64-apple-darwin' },
  'linux-x64': { platform: 'linux', arch: 'x64', triple: 'x86_64-unknown-linux-gnu' },
  'linux-arm64': { platform: 'linux', arch: 'arm64', triple: 'aarch64-unknown-linux-gnu' },
}

export function parseArgs(argv) {
  const opts = { target: 'darwin-arm64', smokeTest: true }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--target') opts.target = argv[++i]
    else if (a.startsWith('--target=')) opts.target = a.slice('--target='.length)
    else if (a === '--skip-smoke-test') opts.smokeTest = false
    else throw new Error(`Unknown argument: ${a}`)
  }
  if (!TARGETS[opts.target]) throw new Error(`Unsupported target ${opts.target}; expected one of ${Object.keys(TARGETS).join(', ')}`)
  return opts
}

/** Fail unless this host can run the target's Node (native modules are built by running it). */
export function assertHostMatches(target, host = { platform: hostPlatform(), arch: hostArch() }) {
  const t = TARGETS[target]
  if (host.platform !== t.platform || host.arch !== t.arch) {
    throw new Error(`Target ${target} must be built on ${t.platform}/${t.arch}; this host is ${host.platform}/${host.arch}`)
  }
}

/** Read and validate desktop/node-runtime.json. */
export function readRuntimePin(file = join(DESKTOP_DIR, 'node-runtime.json')) {
  const pin = JSON.parse(readFileSync(file, 'utf-8'))
  if (!/^\d+\.\d+\.\d+$/.test(pin.version ?? '')) throw new Error(`${file}: version must be x.y.z`)
  for (const [target, sum] of Object.entries(pin.sha256 ?? {})) {
    if (!/^[0-9a-f]{64}$/.test(sum)) throw new Error(`${file}: sha256.${target} is not a SHA-256 hex digest`)
  }
  return pin
}

export function nodeDistName(version, target) {
  return `node-v${version}-${target}`
}

export async function sha256File(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

/**
 * The pinned Node tarball, downloaded once into desktop/.cache/ and verified
 * against the pinned checksum every time (a cached file is not trusted).
 */
export async function fetchNode(pin, target, { cacheDir = join(DESKTOP_DIR, '.cache'), fetchImpl = fetch } = {}) {
  const expected = pin.sha256[target]
  if (!expected) throw new Error(`node-runtime.json has no sha256 for ${target}`)
  const name = `${nodeDistName(pin.version, target)}.tar.gz`
  const file = join(cacheDir, name)
  mkdirSync(cacheDir, { recursive: true })
  if (!existsSync(file)) {
    const url = `https://nodejs.org/dist/v${pin.version}/${name}`
    log(`downloading ${url}`)
    const res = await fetchImpl(url)
    if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`)
    const partial = `${file}.partial`
    writeFileSync(partial, Buffer.from(await res.arrayBuffer()))
    renameSync(partial, file)
  }
  const actual = await sha256File(file)
  if (actual !== expected) {
    rmSync(file, { force: true })
    throw new Error(`${name}: SHA-256 ${actual} does not match the pinned ${expected}`)
  }
  return file
}

/** Check that the lockfile describes this package.json (same name and version). */
export function assertLockfileMatches(pkg, lock) {
  if (lock.name !== pkg.name || lock.version !== pkg.version) {
    throw new Error(`package-lock.json is for ${lock.name}@${lock.version}, package.json is ${pkg.name}@${pkg.version}`)
  }
  const root = lock.packages?.['']
  if (!root) throw new Error('package-lock.json has no root package entry (lockfileVersion 2+ required)')
}

function log(message) {
  process.stderr.write(`[bundle-server] ${message}\n`)
}

/**
 * What to do with the payload's native addons (`*.node`, paths relative to the
 * payload) for one target. Prebuilds for other platforms can never load, so
 * they go. On macOS the rest are re-signed ad-hoc: npm prebuilds carry their
 * publisher's Team ID, and the bundled Node, signed ad-hoc under the hardened
 * runtime, refuses to load code from a different team ("mapping process and
 * mapped file (non-platform) have different Team IDs").
 */
export function nativeAddonPlan(files, target) {
  const t = TARGETS[target]
  const remove = []
  const sign = []
  for (const file of files) {
    const parts = file.split(/[\\/]/)
    const i = parts.lastIndexOf('prebuilds')
    const prebuild = i >= 0 ? parts[parts.length - 1].replace(/\.node$/, '') : null
    if (prebuild && !prebuild.startsWith(`${t.platform}-${t.arch}`)) remove.push(file)
    else if (t.platform === 'darwin') sign.push(file)
  }
  return { remove, sign }
}

/**
 * `codesign` arguments for one native addon. With a Developer ID identity
 * (CODEKIN_CODESIGN_IDENTITY, set by the release job once the Apple secrets
 * exist) addons are signed for notarization: hardened runtime and a secure
 * timestamp. Without one they are signed ad-hoc, like the rest of an
 * unsigned build.
 */
export function codesignArgs(identity, file) {
  return identity
    ? ['--force', '--options', 'runtime', '--timestamp', '--sign', identity, file]
    : ['--force', '--sign', '-', file]
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${r.status ?? r.signal}`)
}

/** The environment without `npm_*` variables, which an outer `npm run` sets to point at its own npm and config. */
export function withoutNpmEnv(base = process.env) {
  return Object.fromEntries(Object.entries(base).filter(([k]) => !k.toLowerCase().startsWith('npm_')))
}

/** Environment for the pinned Node and its npm: that Node first on PATH, production install. */
export function pinnedNodeEnv(nodeBinDir, base = process.env) {
  return { ...withoutNpmEnv(base), PATH: `${nodeBinDir}:${base.PATH ?? ''}`, NODE_ENV: 'production' }
}

export async function bundleServer({ target = 'darwin-arm64', smokeTest = true } = {}) {
  assertHostMatches(target)
  const pin = readRuntimePin()
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'))
  const lock = JSON.parse(readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf-8'))
  assertLockfileMatches(pkg, lock)

  for (const required of ['dist/index.html', 'server/dist/ws-server.js']) {
    if (!existsSync(join(REPO_ROOT, required))) {
      throw new Error(`${required} is missing: run \`npm run build\` and \`npx tsc -p server/tsconfig.json\` in the repository root first`)
    }
  }

  const buildDir = join(DESKTOP_DIR, 'build')
  const payloadDir = join(buildDir, 'codekin')
  const work = mkdtempSync(join(tmpdir(), 'codekin-bundle-'))
  try {
    // 1. npm pack (from the repository, with the host's npm: packing runs no native code).
    log(`packing ${pkg.name}@${pkg.version}`)
    const packOut = execFileSync('npm', ['pack', '--json', '--pack-destination', work], {
      cwd: REPO_ROOT, encoding: 'utf-8', env: withoutNpmEnv(), stdio: ['ignore', 'pipe', 'inherit'],
    })
    const tgz = join(work, JSON.parse(packOut)[0].filename)

    // 2. Unpack and add the lockfile from the same commit.
    run('tar', ['-xzf', tgz, '-C', work])
    rmSync(buildDir, { recursive: true, force: true })
    mkdirSync(buildDir, { recursive: true })
    renameSync(join(work, 'package'), payloadDir)
    copyFileSync(join(REPO_ROOT, 'package-lock.json'), join(payloadDir, 'package-lock.json'))

    // 3. Pinned Node, then production dependencies built for it.
    const tarball = await fetchNode(pin, target)
    run('tar', ['-xzf', tarball, '-C', work])
    const nodeHome = join(work, nodeDistName(pin.version, target))
    const nodeBin = join(nodeHome, 'bin', 'node')
    const reported = execFileSync(nodeBin, ['-p', 'process.version + " " + process.platform + "/" + process.arch'], { encoding: 'utf-8' }).trim()
    const t = TARGETS[target]
    if (reported !== `v${pin.version} ${t.platform}/${t.arch}`) throw new Error(`pinned Node reports ${reported}`)
    log(`installing production dependencies with Node ${reported}`)
    const env = pinnedNodeEnv(join(nodeHome, 'bin'))
    // No production dependency needs an install script. `npm ci` would still run an
    // implied `node-gyp rebuild` for better-sqlite3 (the lockfile drops its
    // `gypfile: false`), compiling an addon its prebuilt binary makes unused.
    run(join(nodeHome, 'bin', 'npm'), ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: payloadDir, env })
    // Only needed to install; the app doesn't ship npm.
    rmSync(join(payloadDir, 'package-lock.json'))

    const addons = readdirSync(join(payloadDir, 'node_modules'), { recursive: true })
      .map(String)
      .filter(f => f.endsWith('.node'))
      .map(f => join('node_modules', f))
    const plan = nativeAddonPlan(addons, target)
    for (const f of plan.remove) rmSync(join(payloadDir, f))
    const identity = process.env.CODEKIN_CODESIGN_IDENTITY || ''
    for (const f of plan.sign) run('codesign', codesignArgs(identity, join(payloadDir, f)))
    log(`native addons: ${plan.sign.length} signed ${identity ? `with ${identity}` : 'ad-hoc'}, ${plan.remove.length} other-platform prebuilds removed`)

    execFileSync(nodeBin, ['-e', "const D=require('better-sqlite3');const d=new D(':memory:');d.exec('select 1');d.close()"], { cwd: payloadDir, stdio: 'inherit' })

    // 4. Sidecar.
    const binDir = join(DESKTOP_DIR, 'src-tauri', 'binaries')
    mkdirSync(binDir, { recursive: true })
    const sidecar = join(binDir, `node-${t.triple}`)
    copyFileSync(nodeBin, sidecar)
    chmodSync(sidecar, 0o755)
    writeFileSync(join(buildDir, 'payload.json'), JSON.stringify({
      codekinVersion: pkg.version, node: pin.version, target, sidecar: `binaries/node-${t.triple}`,
    }, null, 2) + '\n')
    log(`payload ready: ${payloadDir}; sidecar ${sidecar}`)

    // 5. Smoke test.
    if (smokeTest) {
      const { runSmokeTest } = await import('./smoke-test.mjs')
      await runSmokeTest({ nodeBin: sidecar, payloadDir })
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await bundleServer(parseArgs(process.argv.slice(2)))
  } catch (err) {
    log(`FAILED: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
