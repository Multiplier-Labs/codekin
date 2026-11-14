/**
 * Launch configurations for Canvas previews (docs/CANVAS-SPEC.md §8).
 *
 * A repository describes its dev servers in `.claude/launch.json`, the file
 * Claude Code's desktop app uses (JSON with comments):
 *
 *   { "version": "0.0.1",
 *     "configurations": [
 *       { "name": "web", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev"], "port": 5173 } ] }
 *
 * Codekin reads `name`, `runtimeExecutable` + `runtimeArgs` (or `program` +
 * `args`, run with node), `port` (default 3000), `cwd`, `env` and a localhost
 * `url`. An entry with only a `url` attaches to a server you run yourself.
 * Only the user starts these, after seeing the command: an agent never asks
 * Codekin to run anything.
 */

import { createHash } from 'crypto'
import { existsSync, promises as fs, realpathSync } from 'fs'
import path from 'path'
import type { PreviewLaunchConfig } from './protocol.js'

export const LAUNCH_FILE = '.claude/launch.json'
const MAX_LAUNCH_FILE = 256 * 1024

/** A configuration ready to start: the resolved command and folder. */
export interface ResolvedLaunchConfig extends PreviewLaunchConfig {
  /** Null for an attach-only entry (a `url` without a command). */
  executable: string | null
  args: string[]
  /** Absolute working directory, inside the session's folder. */
  absCwd: string
  env: Record<string, string>
}

/** JSON with // and block comments and trailing commas, as VS Code-style launch files allow. */
export function parseJsonc(text: string): unknown {
  let out = ''
  let i = 0
  let inString = false
  while (i < text.length) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === '\\') { out += text[i + 1] ?? ''; i += 2; continue }
      if (c === '"') inString = false
      i++
      continue
    }
    if (c === '"') { inString = true; out += c; i++; continue }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 2
      continue
    }
    out += c
    i++
  }
  return JSON.parse(dropTrailingCommas(out))
}

/** Remove commas directly before } or ], outside strings. */
function dropTrailingCommas(text: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === '\\') { out += text[++i] ?? '' } else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    if (c === ',') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j++
      if (text[j] === '}' || text[j] === ']') continue
    }
    out += c
  }
  return out
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

function isLocalHost(host: string): boolean {
  return LOCAL_HOSTS.has(host) || host.endsWith('.localhost')
}

const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

/** The command line as the user sees it before starting it. */
export function displayCommand(executable: string, args: string[]): string {
  return [executable, ...args].map(quote).join(' ')
}

function substitute(value: string, root: string): string {
  return value.replace(/\$\{workspaceFolder\}/g, root)
}

function stringArray(v: unknown): string[] | null {
  return Array.isArray(v) && v.every(a => typeof a === 'string') ? v : null
}

/**
 * One configuration entry, checked. Problems are reported on the entry
 * (`error`) so the user sees which one is wrong and why, instead of the
 * whole file disappearing.
 */
export function resolveLaunchEntry(entry: unknown, root: string, index: number): ResolvedLaunchConfig {
  const e = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>
  const name = typeof e.name === 'string' && e.name.trim() ? e.name.trim() : `configuration ${index + 1}`
  const base: ResolvedLaunchConfig = { name, command: null, port: 3000, executable: null, args: [], absCwd: root, env: {} }
  const fail = (error: string): ResolvedLaunchConfig => ({ ...base, error })

  if (e.port !== undefined && (typeof e.port !== 'number' || !Number.isInteger(e.port) || e.port < 1 || e.port > 65535)) {
    return fail('port must be a number from 1 to 65535.')
  }
  let port = typeof e.port === 'number' ? e.port : 3000

  if (e.url !== undefined) {
    let u: URL
    try { u = new URL(String(e.url)) } catch { return fail(`url is not an address: ${String(e.url)}`) }
    if (u.protocol !== 'http:') return fail('Codekin previews plain http servers on this machine; url must start with http://.')
    if (!isLocalHost(u.hostname)) return fail(`Codekin only previews servers on this machine (localhost), not ${u.hostname}.`)
    if (u.username || u.password) return fail('url must not contain a username or password.')
    const urlPort = u.port ? Number(u.port) : 80
    if (e.port !== undefined && urlPort !== port) return fail(`url's port (${urlPort}) must match port (${port}).`)
    port = urlPort
    base.url = u.origin
  }
  base.port = port

  if (e.env !== undefined) {
    if (typeof e.env !== 'object' || e.env === null || Array.isArray(e.env) || !Object.values(e.env).every(v => typeof v === 'string')) {
      return fail('env must map names to strings.')
    }
    for (const [k, v] of Object.entries(e.env as Record<string, string>)) base.env[k] = substitute(v, root)
  }

  if (e.cwd !== undefined) {
    if (typeof e.cwd !== 'string') return fail('cwd must be a folder path.')
    const rel = substitute(e.cwd, root)
    const abs = path.resolve(root, rel)
    let real: string
    try { real = realpathSync(abs) } catch { return fail(`cwd ${e.cwd} does not exist.`) }
    const realRoot = realpathSync(root)
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return fail(`cwd ${e.cwd} is outside the project.`)
    base.absCwd = real
    base.cwd = path.relative(realRoot, real) || '.'
  }

  let executable: string | null = null
  let args: string[] = []
  if (typeof e.runtimeExecutable === 'string' && e.runtimeExecutable.trim()) {
    executable = substitute(e.runtimeExecutable.trim(), root)
    const a = e.runtimeArgs === undefined ? [] : stringArray(e.runtimeArgs)
    if (!a) return fail('runtimeArgs must be a list of strings.')
    args = a.map(s => substitute(s, root))
  } else if (typeof e.program === 'string' && e.program.trim()) {
    executable = 'node'
    const a = e.args === undefined ? [] : stringArray(e.args)
    if (!a) return fail('args must be a list of strings.')
    args = [substitute(e.program.trim(), root), ...a.map(s => substitute(s, root))]
  } else if (e.runtimeExecutable !== undefined || e.program !== undefined) {
    return fail('runtimeExecutable (or program) must be a command.')
  } else if (!base.url) {
    return fail('Give a command (runtimeExecutable, or program) or the url of a server you run yourself.')
  }

  return { ...base, executable, args, command: executable ? displayCommand(executable, args) : null }
}

/** The session folder's launch configurations; `error` when the file can't be read. */
export async function readLaunchConfigs(root: string): Promise<{ file: string; configs: ResolvedLaunchConfig[]; error?: string }> {
  const file = path.join(root, LAUNCH_FILE)
  if (!existsSync(file)) return { file: LAUNCH_FILE, configs: [] }
  let parsed: unknown
  try {
    // A plain file of a sane size, checked before reading: the repository
    // decides what this path is (a symlink to /dev/zero, a huge file).
    const stat = await fs.lstat(file)
    if (!stat.isFile()) return { file: LAUNCH_FILE, configs: [], error: `${LAUNCH_FILE} must be a plain file, not a link.` }
    if (stat.size > MAX_LAUNCH_FILE) return { file: LAUNCH_FILE, configs: [], error: `${LAUNCH_FILE} is too large.` }
    const text = await fs.readFile(file, 'utf-8')
    parsed = parseJsonc(text)
  } catch (err) {
    return { file: LAUNCH_FILE, configs: [], error: `${LAUNCH_FILE} can't be read: ${err instanceof Error ? err.message : String(err)}` }
  }
  const list = (parsed as { configurations?: unknown } | null)?.configurations
  if (!Array.isArray(list)) return { file: LAUNCH_FILE, configs: [], error: `${LAUNCH_FILE} has no "configurations" list.` }
  const configs = list.slice(0, 50).map((entry, i) => resolveLaunchEntry(entry, root, i))
  // Names pick the entry to start, so the first of a duplicate name wins.
  const seen = new Set<string>()
  return {
    file: LAUNCH_FILE,
    configs: configs.map(c => {
      if (!seen.has(c.name)) { seen.add(c.name); return c }
      return { ...c, error: `Another configuration is also named "${c.name}".` }
    }),
  }
}

/**
 * What the user approves when they start a configuration: the command, its
 * folder and its environment. Starting sends this back, and Codekin refuses
 * when the file says something else by then.
 */
export function launchDigest(c: ResolvedLaunchConfig): string {
  return createHash('sha256').update(JSON.stringify([c.executable, c.args, c.absCwd, Object.entries(c.env).sort(), c.port])).digest('hex').slice(0, 32)
}

/** The wire shape: everything the user should see before starting it (no absolute paths). */
export function publicConfig(c: ResolvedLaunchConfig): PreviewLaunchConfig {
  return {
    name: c.name, command: c.command, port: c.port,
    ...(c.cwd ? { cwd: c.cwd } : {}), ...(c.url ? { url: c.url } : {}), ...(c.error ? { error: c.error } : {}),
    // Values too: they come from the repository, and they change what runs (NODE_OPTIONS, PATH).
    ...(Object.keys(c.env).length ? { env: c.env } : {}),
    ...(c.executable ? { digest: launchDigest(c) } : {}),
  }
}
