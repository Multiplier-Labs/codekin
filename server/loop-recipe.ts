/**
 * Loop recipe v2 — the authorable definition behind Loops 2.0.
 *
 * A recipe is a Markdown file with YAML frontmatter (`apiVersion:
 * codekin.dev/v2`, `kind: LoopRecipe`) followed by a body that becomes the
 * default outcome prompt. Recipes are read from two places:
 *
 *   - built-ins shipped with the package in server/loops/*.md
 *   - per-repo overrides in {repoPath}/.codekin/loops/*.md (same id wins)
 *
 * Validation is strict: unknown fields fail, so a typo'd field can never be
 * silently ignored. The parsed recipe is normalized and content-hashed; every
 * run freezes the normalized recipe + hash it was started from, so a later
 * edit to the file never changes what a past run claims it executed.
 *
 * Phase 1 executes `command` and `rubric` evaluators. Other §7 evaluator
 * types (test-report, diff-policy, artifact, ci, human, composite) arrive in
 * Phase 3 and are rejected at validation until then — accepting a field the
 * engine ignores would be a silent lie.
 *
 * Example:
 *
 *   ---
 *   apiVersion: codekin.dev/v2
 *   kind: LoopRecipe
 *   metadata:
 *     id: ci-repair
 *     name: Repair failing CI
 *   agent:
 *     provider: auto
 *   workspace:
 *     strategy: worktree
 *     protectedPaths: [".github/workflows/**"]
 *   evaluators:
 *     - id: tests
 *       type: command
 *       command: npm test
 *       timeout: 10m
 *     - id: review
 *       type: rubric
 *       provider: different-from-maker
 *   budgets:
 *     turns: 12
 *     costUsd: 5
 *     wallTime: 45m
 *   policy:
 *     mode: guarded
 *   completion:
 *     action: pull-request
 *   ---
 *   The CI checks are failing on this branch. Diagnose and fix the root cause...
 */

import { createHash } from 'crypto'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { parse as parseYaml } from 'yaml'
import { splitFrontmatter } from './frontmatter.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LoopProvider = 'claude' | 'opencode' | 'codex'
export type LoopProviderSpec = LoopProvider | 'auto'
export type LoopMode = 'guided' | 'guarded' | 'autonomous'
export type CompletionAction = 'pull-request' | 'commit-only'

export interface CommandEvaluatorConfig {
  id: string
  type: 'command'
  /** Shell string (trusted repository code) or argv array. */
  command: string | string[]
  /** Milliseconds. */
  timeoutMs: number
  required: boolean
  /** Extra attempts when the failure classifies as transient/infra. */
  retryMaxAttempts: number
}

export interface RubricEvaluatorConfig {
  id: string
  type: 'rubric'
  /** 'different-from-maker' resolves at run start against the resolved agent provider. */
  provider: LoopProvider | 'different-from-maker'
  model?: string
  /** Extra review guidance appended to the reviewer prompt. */
  instructions?: string
  required: boolean
}

export type EvaluatorConfig = CommandEvaluatorConfig | RubricEvaluatorConfig

export interface LoopBudgets {
  /** Hard cap on maker turns. */
  turns: number
  /** Hard cap on cumulative USD cost across all sessions of the run. */
  costUsd: number
  /** Wall-clock cap in ms; undefined = unlimited. */
  wallTimeMs?: number
  /** Evaluate cycles with no material progress before escalating. */
  noProgressAttempts: number
}

export interface LoopRecipe {
  apiVersion: 'codekin.dev/v2'
  id: string
  name: string
  description?: string
  agent: { provider: LoopProviderSpec; model?: string }
  workspace: { strategy: 'worktree'; protectedPaths: string[] }
  evaluators: EvaluatorConfig[]
  budgets: LoopBudgets
  policy: { mode: LoopMode }
  completion: { action: CompletionAction }
  /** Default outcome prompt (the markdown body). */
  outcome: string
  source: 'builtin' | 'repo'
  /** sha256 of the normalized recipe — frozen into every run. */
  contentHash: string
}

export interface LoopRecipeInfo {
  id: string
  name: string
  description?: string
  source: 'builtin' | 'repo'
}

const PROVIDERS: readonly LoopProvider[] = ['claude', 'opencode', 'codex']
const MODES: readonly LoopMode[] = ['guided', 'guarded', 'autonomous']
// No 'merge': auto-merge is a policy decision the spec defers — accepting the
// field while only pushing a branch (what v1 did) would misstate what happens.
const ACTIONS: readonly CompletionAction[] = ['pull-request', 'commit-only']

/** Recipe ids appear in branch names, session names, and API paths. */
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

export function isValidRecipeId(id: unknown): id is string {
  return typeof id === 'string' && ID_PATTERN.test(id)
}

const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_NO_PROGRESS_ATTEMPTS = 3

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function fail(sourcePath: string, msg: string): never {
  throw new Error(`Invalid loop recipe ${sourcePath}: ${msg}`)
}

function asRecord(value: unknown, field: string, sourcePath: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(sourcePath, `${field} must be a YAML mapping`)
  }
  return value as Record<string, unknown>
}

/** Strict-mode guard: any key outside `allowed` fails validation. */
function rejectUnknown(obj: Record<string, unknown>, allowed: string[], field: string, sourcePath: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(sourcePath, `unknown field ${field}.${key}`)
  }
}

function optionalString(value: unknown, field: string, sourcePath: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim()) fail(sourcePath, `${field} must be a non-empty string`)
  return value
}

function requiredString(value: unknown, field: string, sourcePath: string): string {
  const s = optionalString(value, field, sourcePath)
  if (s === undefined) fail(sourcePath, `${field} is required`)
  return s
}

function positiveNumber(value: unknown, field: string, sourcePath: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail(sourcePath, `${field} must be a positive number`)
  }
  return value
}

function stringArray(value: unknown, field: string, sourcePath: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v.trim())) {
    fail(sourcePath, `${field} must be a list of non-empty strings`)
  }
  return value as string[]
}

/**
 * Parse a duration literal — `90s`, `10m`, `2h`, or a bare number of minutes —
 * into milliseconds.
 */
export function parseDurationMs(value: unknown, field: string, sourcePath: string): number {
  if (typeof value === 'number') return positiveNumber(value, field, sourcePath) * 60 * 1000
  if (typeof value === 'string') {
    const m = value.trim().match(/^(\d+(?:\.\d+)?)(s|m|h)$/)
    if (m) {
      const n = Number(m[1])
      const unit = m[2] === 's' ? 1000 : m[2] === 'm' ? 60 * 1000 : 60 * 60 * 1000
      if (n > 0) return n * unit
    }
  }
  fail(sourcePath, `${field} must be a duration like "90s", "10m", or "2h"`)
}

// ---------------------------------------------------------------------------
// Section parsers
// ---------------------------------------------------------------------------

function parseAgent(value: unknown, sourcePath: string): LoopRecipe['agent'] {
  const obj = asRecord(value ?? fail(sourcePath, 'agent is required'), 'agent', sourcePath)
  rejectUnknown(obj, ['provider', 'model'], 'agent', sourcePath)
  const provider = requiredString(obj.provider, 'agent.provider', sourcePath)
  if (provider !== 'auto' && !PROVIDERS.includes(provider as LoopProvider)) {
    fail(sourcePath, `agent.provider must be auto or one of ${PROVIDERS.join(', ')}`)
  }
  return { provider: provider as LoopProviderSpec, model: optionalString(obj.model, 'agent.model', sourcePath) }
}

function parseWorkspace(value: unknown, sourcePath: string): LoopRecipe['workspace'] {
  if (value === undefined) return { strategy: 'worktree', protectedPaths: [] }
  const obj = asRecord(value, 'workspace', sourcePath)
  rejectUnknown(obj, ['strategy', 'protectedPaths'], 'workspace', sourcePath)
  const strategy = obj.strategy ?? 'worktree'
  if (strategy !== 'worktree') fail(sourcePath, `workspace.strategy must be "worktree" (the only Phase 1 strategy)`)
  const protectedPaths = obj.protectedPaths === undefined ? [] : stringArray(obj.protectedPaths, 'workspace.protectedPaths', sourcePath)
  return { strategy: 'worktree', protectedPaths }
}

function parseEvaluator(value: unknown, index: number, sourcePath: string): EvaluatorConfig {
  const field = `evaluators[${index}]`
  const obj = asRecord(value, field, sourcePath)
  const id = requiredString(obj.id, `${field}.id`, sourcePath)
  if (!ID_PATTERN.test(id)) fail(sourcePath, `${field}.id must be a lowercase slug`)
  const type = requiredString(obj.type, `${field}.type`, sourcePath)
  const required = obj.required === undefined ? true : obj.required
  if (typeof required !== 'boolean') fail(sourcePath, `${field}.required must be a boolean`)

  if (type === 'command') {
    rejectUnknown(obj, ['id', 'type', 'command', 'timeout', 'required', 'retry'], field, sourcePath)
    const command = obj.command
    const isArgv = Array.isArray(command)
    if (isArgv) stringArray(command, `${field}.command`, sourcePath)
    else if (typeof command !== 'string' || !command.trim()) {
      fail(sourcePath, `${field}.command must be a shell string or an argv array`)
    }
    let retryMaxAttempts = 1
    if (obj.retry !== undefined) {
      const retry = asRecord(obj.retry, `${field}.retry`, sourcePath)
      rejectUnknown(retry, ['maxAttempts'], `${field}.retry`, sourcePath)
      retryMaxAttempts = positiveNumber(retry.maxAttempts, `${field}.retry.maxAttempts`, sourcePath)
    }
    return {
      id,
      type: 'command',
      command: command as string | string[],
      timeoutMs: obj.timeout === undefined ? DEFAULT_COMMAND_TIMEOUT_MS : parseDurationMs(obj.timeout, `${field}.timeout`, sourcePath),
      required,
      retryMaxAttempts,
    }
  }

  if (type === 'rubric') {
    rejectUnknown(obj, ['id', 'type', 'provider', 'model', 'instructions', 'required'], field, sourcePath)
    const provider = requiredString(obj.provider, `${field}.provider`, sourcePath)
    if (provider !== 'different-from-maker' && !PROVIDERS.includes(provider as LoopProvider)) {
      fail(sourcePath, `${field}.provider must be different-from-maker or one of ${PROVIDERS.join(', ')}`)
    }
    return {
      id,
      type: 'rubric',
      provider: provider as RubricEvaluatorConfig['provider'],
      model: optionalString(obj.model, `${field}.model`, sourcePath),
      instructions: optionalString(obj.instructions, `${field}.instructions`, sourcePath),
      required,
    }
  }

  fail(sourcePath, `${field}.type "${type}" is not available yet — Phase 1 supports: command, rubric`)
}

function parseEvaluators(value: unknown, sourcePath: string): EvaluatorConfig[] {
  if (!Array.isArray(value) || value.length === 0) fail(sourcePath, 'evaluators must list at least one evaluator')
  const parsed = value.map((v, i) => parseEvaluator(v, i, sourcePath))
  const ids = new Set<string>()
  for (const e of parsed) {
    if (ids.has(e.id)) fail(sourcePath, `duplicate evaluator id "${e.id}"`)
    ids.add(e.id)
  }
  if (!parsed.some((e) => e.type === 'command' && e.required)) {
    fail(sourcePath, 'at least one required command evaluator is needed — a loop must have a deterministic gate')
  }
  return parsed
}

function parseBudgets(value: unknown, sourcePath: string): LoopBudgets {
  const obj = asRecord(value ?? fail(sourcePath, 'budgets is required'), 'budgets', sourcePath)
  rejectUnknown(obj, ['turns', 'costUsd', 'wallTime', 'noProgressAttempts'], 'budgets', sourcePath)
  return {
    turns: positiveNumber(obj.turns, 'budgets.turns', sourcePath),
    costUsd: positiveNumber(obj.costUsd, 'budgets.costUsd', sourcePath),
    wallTimeMs: obj.wallTime === undefined ? undefined : parseDurationMs(obj.wallTime, 'budgets.wallTime', sourcePath),
    noProgressAttempts:
      obj.noProgressAttempts === undefined
        ? DEFAULT_NO_PROGRESS_ATTEMPTS
        : positiveNumber(obj.noProgressAttempts, 'budgets.noProgressAttempts', sourcePath),
  }
}

function parsePolicy(value: unknown, sourcePath: string): LoopRecipe['policy'] {
  if (value === undefined) return { mode: 'guarded' }
  const obj = asRecord(value, 'policy', sourcePath)
  rejectUnknown(obj, ['mode'], 'policy', sourcePath)
  const mode = obj.mode ?? 'guarded'
  if (typeof mode !== 'string' || !MODES.includes(mode as LoopMode)) {
    fail(sourcePath, `policy.mode must be one of ${MODES.join(', ')}`)
  }
  return { mode: mode as LoopMode }
}

function parseCompletion(value: unknown, sourcePath: string): LoopRecipe['completion'] {
  if (value === undefined) return { action: 'pull-request' }
  const obj = asRecord(value, 'completion', sourcePath)
  rejectUnknown(obj, ['action'], 'completion', sourcePath)
  const action = obj.action ?? 'pull-request'
  if (typeof action !== 'string' || !ACTIONS.includes(action as CompletionAction)) {
    fail(sourcePath, `completion.action must be one of ${ACTIONS.join(', ')}`)
  }
  return { action: action as CompletionAction }
}

// ---------------------------------------------------------------------------
// Parse + normalize
// ---------------------------------------------------------------------------

/**
 * Normalized, order-stable JSON of everything that affects execution — the
 * hash input. Source location is deliberately excluded: the same recipe text
 * hashes identically whether it came from a repo or the package.
 */
function normalizedForHash(recipe: Omit<LoopRecipe, 'contentHash' | 'source'>): string {
  return JSON.stringify(recipe)
}

/** Parse a recipe MD file. Throws with a path-prefixed message on any invalid input. */
export function parseLoopRecipe(content: string, sourcePath: string, source: 'builtin' | 'repo'): LoopRecipe {
  const split = splitFrontmatter(content)
  if (!split) fail(sourcePath, 'no YAML frontmatter found')

  let parsed: unknown
  try {
    parsed = parseYaml(split.frontmatter)
  } catch (err) {
    fail(sourcePath, `frontmatter is not valid YAML: ${err instanceof Error ? err.message : String(err)}`)
  }
  const fm = asRecord(parsed, 'frontmatter', sourcePath)
  rejectUnknown(
    fm,
    ['apiVersion', 'kind', 'metadata', 'agent', 'workspace', 'evaluators', 'budgets', 'policy', 'completion'],
    'recipe',
    sourcePath,
  )
  if (fm.apiVersion !== 'codekin.dev/v2') fail(sourcePath, 'apiVersion must be codekin.dev/v2')
  if (fm.kind !== 'LoopRecipe') fail(sourcePath, 'kind must be LoopRecipe')

  const metadata = asRecord(fm.metadata ?? fail(sourcePath, 'metadata is required'), 'metadata', sourcePath)
  rejectUnknown(metadata, ['id', 'name', 'description'], 'metadata', sourcePath)
  const id = requiredString(metadata.id, 'metadata.id', sourcePath)
  if (!isValidRecipeId(id)) fail(sourcePath, 'metadata.id must be a lowercase slug (letters, digits, ".", "_", "-"; max 64 chars)')

  const outcome = split.body.trim()
  if (!outcome) fail(sourcePath, 'body (outcome prompt) is empty')

  const withoutHash = {
    apiVersion: 'codekin.dev/v2' as const,
    id,
    name: requiredString(metadata.name, 'metadata.name', sourcePath),
    description: optionalString(metadata.description, 'metadata.description', sourcePath),
    agent: parseAgent(fm.agent, sourcePath),
    workspace: parseWorkspace(fm.workspace, sourcePath),
    evaluators: parseEvaluators(fm.evaluators, sourcePath),
    budgets: parseBudgets(fm.budgets, sourcePath),
    policy: parsePolicy(fm.policy, sourcePath),
    completion: parseCompletion(fm.completion, sourcePath),
    outcome,
  }
  const contentHash = createHash('sha256').update(normalizedForHash(withoutHash)).digest('hex')
  return { ...withoutHash, source, contentHash }
}

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

/**
 * Resolve `auto` and `different-from-maker` at run start. `auto` picks claude
 * (the strongest editor of the three); the resolution is recorded on the run
 * so "auto" never hides which provider actually executed.
 */
export function resolveAgentProvider(spec: LoopProviderSpec): LoopProvider {
  return spec === 'auto' ? 'claude' : spec
}

/** A rubric reviewer must not be the model grading its own work. */
export function resolveRubricProvider(spec: RubricEvaluatorConfig['provider'], maker: LoopProvider): LoopProvider {
  if (spec !== 'different-from-maker') return spec
  return maker === 'claude' ? 'codex' : 'claude'
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

/** Built-in recipes dir: server/loops/ from source, one level up from dist. */
const __ownDir = dirname(fileURLToPath(import.meta.url))
const RECIPES_DIR = existsSync(join(__ownDir, 'loops')) ? join(__ownDir, 'loops') : join(__ownDir, '..', 'loops')

function loadFromDir(dir: string, source: 'builtin' | 'repo', strict: boolean): LoopRecipe[] {
  if (!existsSync(dir)) return []
  const out: LoopRecipe[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md')) continue
    const filePath = join(dir, file)
    try {
      out.push(parseLoopRecipe(readFileSync(filePath, 'utf-8'), filePath, source))
    } catch (err) {
      if (strict) throw err
      console.error(`[loop-recipe] Failed to parse ${filePath}:`, err)
    }
  }
  return out
}

/** Load the built-in recipes shipped with the package. */
export function loadBuiltinRecipes(strict = false): LoopRecipe[] {
  return loadFromDir(RECIPES_DIR, 'builtin', strict)
}

/** Scan {repoPath}/.codekin/loops/ for per-repo recipes. */
export function discoverRepoRecipes(repoPath: string): LoopRecipe[] {
  return loadFromDir(join(repoPath, '.codekin', 'loops'), 'repo', false)
}

/** Resolve a recipe by id; a per-repo recipe overrides the built-in of the same id. */
export function loadLoopRecipe(id: string, repoPath?: string): LoopRecipe | null {
  if (repoPath) {
    const override = discoverRepoRecipes(repoPath).find((r) => r.id === id)
    if (override) return override
  }
  return loadBuiltinRecipes().find((r) => r.id === id) ?? null
}

/** List available recipes: built-ins plus repo recipes (repo overrides shadow built-ins). */
export function listLoopRecipes(repoPath?: string): LoopRecipeInfo[] {
  const byId = new Map<string, LoopRecipe>()
  for (const r of loadBuiltinRecipes()) byId.set(r.id, r)
  if (repoPath) for (const r of discoverRepoRecipes(repoPath)) byId.set(r.id, r)
  return [...byId.values()].map((r) => ({ id: r.id, name: r.name, description: r.description, source: r.source }))
}
