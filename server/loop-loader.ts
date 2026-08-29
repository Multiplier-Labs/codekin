/**
 * Loop template loader.
 *
 * A loop template is the authorable recipe for a Goal Run: a markdown file with
 * YAML frontmatter describing the `GoalRunSpec` (maker/checker providers, verify
 * commands, readonly constraints, budgets, completion policy) followed by a body
 * that becomes the default goal text.
 *
 * Templates are read from two places, mirroring the workflow loader:
 *   - built-ins shipped with the package in server/loops/*.md
 *   - per-repo overrides in {repoPath}/.codekin/loops/*.md (same `kind` wins)
 *
 * MD file format:
 *
 *   ---
 *   kind: ci-autorepair
 *   name: CI Autorepair
 *   maker:
 *     provider: claude
 *   checker:           # optional — omit for a single-provider loop
 *     provider: opencode
 *   verify:
 *     - npm test
 *     - npm run lint
 *   readonly:          # optional
 *     - .github/workflows/**
 *   maxTurns: 12
 *   maxCostUsd: 5
 *   completionPolicy: pr
 *   ---
 *   The CI checks are failing on this branch. Diagnose and fix the root cause...
 *
 * The frontmatter is structured (nested objects, arrays) so it is parsed with the
 * `yaml` library rather than the line-based key:value scan the workflow loader uses.
 */

import { existsSync, readdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { parse as parseYaml } from 'yaml'
import type {
  CompletionPolicy,
  CreateGoalRunInput,
  GoalRunKind,
  GoalRunSpec,
  LoopProvider,
  ProviderRole,
} from './goal-run-store.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LoopTemplate {
  kind: GoalRunKind
  name: string
  spec: GoalRunSpec
  /** Default goal text from the MD body. */
  goal: string
  source: 'builtin' | 'repo'
}

export interface LoopTemplateInfo {
  kind: GoalRunKind
  name: string
  source: 'builtin' | 'repo'
}

const PROVIDERS: readonly LoopProvider[] = ['claude', 'opencode', 'codex']

/**
 * Kinds are an open set (any template file can introduce one) but must be safe
 * slugs: they appear in session names, branch names, and API paths.
 */
const KIND_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

export function isValidLoopKind(kind: unknown): boolean {
  return typeof kind === 'string' && KIND_PATTERN.test(kind)
}
const POLICIES: readonly CompletionPolicy[] = ['pr', 'merge', 'commit-only']

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function fail(sourcePath: string, msg: string): never {
  throw new Error(`Invalid loop template ${sourcePath}: ${msg}`)
}

function asRecord(value: unknown, sourcePath: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(sourcePath, 'frontmatter must be a YAML mapping')
  }
  return value as Record<string, unknown>
}

function parseProviderRole(value: unknown, field: string, sourcePath: string): ProviderRole {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(sourcePath, `${field} must be a mapping with a provider`)
  }
  const obj = value as Record<string, unknown>
  const provider = obj.provider
  if (typeof provider !== 'string' || !PROVIDERS.includes(provider as LoopProvider)) {
    fail(sourcePath, `${field}.provider must be one of ${PROVIDERS.join(', ')}`)
  }
  const role: ProviderRole = { provider: provider as LoopProvider }
  if (obj.model !== undefined) {
    if (typeof obj.model !== 'string') fail(sourcePath, `${field}.model must be a string`)
    role.model = obj.model
  }
  return role
}

function parseStringArray(value: unknown, field: string, sourcePath: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    fail(sourcePath, `${field} must be a list of strings`)
  }
  return value as string[]
}

function parsePositiveNumber(value: unknown, field: string, sourcePath: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail(sourcePath, `${field} must be a positive number`)
  }
  return value
}

/** Build a validated GoalRunSpec + kind/name from parsed frontmatter. */
function specFromFrontmatter(fm: Record<string, unknown>, sourcePath: string): { kind: GoalRunKind; name: string; spec: GoalRunSpec } {
  const kind = fm.kind
  if (typeof kind !== 'string' || !isValidLoopKind(kind)) {
    fail(sourcePath, 'kind must be a lowercase slug (letters, digits, ".", "_", "-"; max 64 chars)')
  }
  const name = fm.name
  if (typeof name !== 'string' || !name.trim()) fail(sourcePath, 'name is required')

  if (fm.maker === undefined) fail(sourcePath, 'maker is required')
  const maker = parseProviderRole(fm.maker, 'maker', sourcePath)
  const checker = fm.checker == null ? null : parseProviderRole(fm.checker, 'checker', sourcePath)

  const verify = parseStringArray(fm.verify, 'verify', sourcePath)
  if (verify.length === 0) fail(sourcePath, 'verify must list at least one command')

  const readonly = fm.readonly === undefined ? undefined : parseStringArray(fm.readonly, 'readonly', sourcePath)

  const policy = fm.completionPolicy ?? 'pr'
  if (typeof policy !== 'string' || !POLICIES.includes(policy as CompletionPolicy)) {
    fail(sourcePath, `completionPolicy must be one of ${POLICIES.join(', ')}`)
  }

  const spec: GoalRunSpec = {
    maker,
    checker,
    verify,
    readonly,
    maxTurns: parsePositiveNumber(fm.maxTurns, 'maxTurns', sourcePath),
    maxCostUsd: parsePositiveNumber(fm.maxCostUsd, 'maxCostUsd', sourcePath),
    completionPolicy: policy as CompletionPolicy,
  }
  return { kind, name, spec }
}

/** Parse a loop MD file into a LoopTemplate. Throws on malformed/unsafe input. */
export function parseLoopTemplate(content: string, sourcePath: string, source: 'builtin' | 'repo'): LoopTemplate {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!fmMatch) fail(sourcePath, 'no YAML frontmatter found')

  let parsed: unknown
  try {
    parsed = parseYaml(fmMatch[1])
  } catch (err) {
    fail(sourcePath, `frontmatter is not valid YAML: ${err instanceof Error ? err.message : String(err)}`)
  }
  const fm = asRecord(parsed, sourcePath)
  const goal = fmMatch[2].trim()
  if (!goal) fail(sourcePath, 'body (goal text) is empty')

  const { kind, name, spec } = specFromFrontmatter(fm, sourcePath)
  return { kind, name, spec, goal, source }
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

/**
 * Resolve the built-in loops directory. When running from server/dist/ the MD
 * files live one level up in server/loops/; from source they sit alongside.
 */
const __ownDir = dirname(fileURLToPath(import.meta.url))
const LOOPS_DIR = existsSync(join(__ownDir, 'loops')) ? join(__ownDir, 'loops') : join(__ownDir, '..', 'loops')

function loadFromDir(dir: string, source: 'builtin' | 'repo', strict: boolean): LoopTemplate[] {
  if (!existsSync(dir)) return []
  const out: LoopTemplate[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md')) continue
    const filePath = join(dir, file)
    try {
      out.push(parseLoopTemplate(readFileSync(filePath, 'utf-8'), filePath, source))
    } catch (err) {
      if (strict) throw err
      console.error(`[loop-loader] Failed to parse ${filePath}:`, err)
    }
  }
  return out
}

/** Load the built-in loop templates shipped with the package. */
export function loadBuiltinLoops(strict = false): LoopTemplate[] {
  if (!existsSync(LOOPS_DIR)) {
    console.warn(`[loop-loader] Built-in loops dir not found: ${LOOPS_DIR}`)
    return []
  }
  return loadFromDir(LOOPS_DIR, 'builtin', strict)
}

/** Scan {repoPath}/.codekin/loops/ for per-repo loop templates. */
export function discoverRepoLoops(repoPath: string): LoopTemplate[] {
  return loadFromDir(join(repoPath, '.codekin', 'loops'), 'repo', false)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a loop template by kind. A per-repo template overrides the built-in of
 * the same kind, mirroring the workflow loader's override semantics.
 */
export function loadLoopTemplate(kind: GoalRunKind, repoPath?: string): LoopTemplate | null {
  if (repoPath) {
    const override = discoverRepoLoops(repoPath).find((t) => t.kind === kind)
    if (override) return override
  }
  return loadBuiltinLoops().find((t) => t.kind === kind) ?? null
}

/** List available loop kinds: built-ins plus any repo templates with a new kind. */
export function listLoopTemplates(repoPath?: string): LoopTemplateInfo[] {
  const builtins = loadBuiltinLoops()
  const infos: LoopTemplateInfo[] = builtins.map((t) => ({ kind: t.kind, name: t.name, source: 'builtin' }))
  if (repoPath) {
    const builtinKinds = new Set(builtins.map((t) => t.kind))
    for (const t of discoverRepoLoops(repoPath)) {
      if (builtinKinds.has(t.kind)) continue
      infos.push({ kind: t.kind, name: t.name, source: 'repo' })
    }
  }
  return infos
}

/**
 * Turn a template into a CreateGoalRunInput for the controller. `repo` and
 * `branch` are runtime values; `goal` overrides the template's default goal text
 * (e.g. a CI-autorepair run injects the actual failing job).
 */
export function buildGoalRunInput(
  template: LoopTemplate,
  opts: { repo: string; branch: string; goal?: string },
): CreateGoalRunInput {
  return {
    kind: template.kind,
    goal: opts.goal?.trim() ? opts.goal.trim() : template.goal,
    spec: template.spec,
    repo: opts.repo,
    branch: opts.branch,
  }
}
