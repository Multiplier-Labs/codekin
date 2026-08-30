/**
 * Evaluators for Loops 2.0 — Phase 1: `command` and `rubric`.
 *
 * A command evaluator is the deterministic gate: run a repo-authored command
 * in the run's worktree, capture exit code and output, classify the failure,
 * and fingerprint it so the engine's no-progress detector can tell "same
 * failure again" from "new failure". Full output becomes an artifact; the
 * summary carries only a tail.
 *
 * The rubric evaluator is the subjective gate — an independent model (a
 * *different* provider than the maker, so no model grades its own work)
 * reviews the diff against the outcome. This module owns its prompt and
 * verdict parsing; the engine owns the session lifecycle.
 *
 * Shell-string commands are trusted repository code (same trust level as
 * package.json scripts or CI config) and run through a shell; argv-array
 * commands run without one. Git helpers run argv-only via diff-manager.
 */

import { exec, execFile } from 'child_process'
import { createHash } from 'crypto'
import { execGit } from './diff-manager.js'
import type { CommandEvaluatorConfig, RubricEvaluatorConfig } from './loop-recipe.js'
import type { EvaluationStatus, FailureClassification } from './loop-store.js'

const DEFAULT_TAIL_LINES = 50
const MAX_BUFFER = 16 * 1024 * 1024 // 16 MB

// ---------------------------------------------------------------------------
// Command evaluator
// ---------------------------------------------------------------------------

export interface CommandEvaluationOutcome {
  evaluatorId: string
  status: Extract<EvaluationStatus, 'pass' | 'fail' | 'error'>
  classification: FailureClassification | null
  /** One line for the run row / event stream. */
  summary: string
  /** Last N lines — what the maker sees as feedback. */
  outputTail: string
  /** Complete combined output — retained as an artifact. */
  fullOutput: string
  /** The command as displayed (argv arrays joined for display only). */
  command: string
  exitCode: number | null
  /** Stable identity of this failure; null on pass. */
  fingerprint: string | null
  retryable: boolean
  durationMs: number
  timedOut: boolean
}

interface ExecFailure {
  code?: number | null
  killed?: boolean
  signal?: NodeJS.Signals | null
  stdout?: string
  stderr?: string
}

function isExecFailure(err: unknown): err is ExecFailure {
  return typeof err === 'object' && err !== null
}

function tail(text: string, lines = DEFAULT_TAIL_LINES): string {
  const trimmed = text.trimEnd()
  const split = trimmed.split('\n')
  if (split.length <= lines) return trimmed
  return split.slice(split.length - lines).join('\n')
}

/**
 * Fingerprint input is normalized so incidental churn (durations, timestamps,
 * absolute tmp paths) does not make every failure look new — the no-progress
 * detector depends on "same failure" hashing identically across attempts.
 */
export function normalizeForFingerprint(text: string): string {
  return text
    .replace(/\d+(\.\d+)?\s*(ms|s|m)\b/g, '<dur>')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<ts>')
    .replace(/\/tmp\/[\w./-]+/g, '<tmp>')
    .replace(/\s+/g, ' ')
    .trim()
}

export function failureFingerprint(evaluatorId: string, exitCode: number | null, outputTail: string): string {
  return createHash('sha256').update(`${evaluatorId}\0${exitCode}\0${normalizeForFingerprint(outputTail)}`).digest('hex')
}

interface RawExecResult {
  exitCode: number | null
  output: string
  timedOut: boolean
  /** Process failed to spawn at all (ENOENT etc.) — an environment problem. */
  spawnError: string | null
}

function execCommand(command: string | string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<RawExecResult> {
  return new Promise((resolve) => {
    const done = (err: unknown, stdout: string, stderr: string) => {
      const output = `${stdout}${stderr}`
      if (!err) {
        resolve({ exitCode: 0, output, timedOut: false, spawnError: null })
        return
      }
      const failure: ExecFailure = isExecFailure(err) ? err : {}
      const timedOut = failure.killed === true
      if (typeof failure.code === 'number') {
        resolve({ exitCode: failure.code, output: `${failure.stdout ?? stdout}${failure.stderr ?? stderr}`, timedOut, spawnError: null })
        return
      }
      // No numeric exit code: killed by signal (timeout) or never spawned.
      const message = err instanceof Error ? err.message : String(err)
      resolve({ exitCode: null, output: output || message, timedOut, spawnError: timedOut ? null : message })
    }
    if (Array.isArray(command)) {
      execFile(command[0], command.slice(1), { cwd, timeout: timeoutMs, maxBuffer: MAX_BUFFER, env }, done)
    } else {
      exec(command, { cwd, timeout: timeoutMs, maxBuffer: MAX_BUFFER, env }, done)
    }
  })
}

export function displayCommand(command: string | string[]): string {
  return Array.isArray(command) ? command.join(' ') : command
}

/**
 * Run one command evaluator once. Retries are the engine's decision (guided by
 * `retryable` + the recipe's retry.maxAttempts), not this function's.
 */
export async function runCommandEvaluator(
  config: CommandEvaluatorConfig,
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<CommandEvaluationOutcome> {
  const startedAt = Date.now()
  const raw = await execCommand(config.command, cwd, config.timeoutMs, { ...process.env, ...(env ?? {}) })
  const durationMs = Date.now() - startedAt
  const command = displayCommand(config.command)
  const outputTail = tail(raw.output)

  if (raw.exitCode === 0) {
    return {
      evaluatorId: config.id,
      status: 'pass',
      classification: null,
      summary: `\`${command}\` passed`,
      outputTail,
      fullOutput: raw.output,
      command,
      exitCode: 0,
      fingerprint: null,
      retryable: false,
      durationMs,
      timedOut: false,
    }
  }

  // Timeouts and spawn failures are environment problems — the code didn't get
  // a verdict — and are worth one retry. A real nonzero exit is a code/test
  // failure verdict; distinguishing code from test needs the Phase 3 parsers.
  const environmental = raw.timedOut || raw.spawnError !== null
  const summary = raw.timedOut
    ? `\`${command}\` timed out after ${Math.round(config.timeoutMs / 1000)}s`
    : raw.spawnError
      ? `\`${command}\` could not start: ${raw.spawnError}`
      : `\`${command}\` exited ${raw.exitCode}`
  return {
    evaluatorId: config.id,
    status: environmental ? 'error' : 'fail',
    classification: environmental ? 'environment' : 'code',
    summary,
    outputTail,
    fullOutput: raw.output,
    command,
    exitCode: raw.exitCode,
    fingerprint: failureFingerprint(config.id, raw.exitCode, outputTail),
    retryable: environmental,
    durationMs,
    timedOut: raw.timedOut,
  }
}

// ---------------------------------------------------------------------------
// Rubric evaluator (prompt + verdict parsing; the engine drives the session)
// ---------------------------------------------------------------------------

export type RubricVerdict = 'approve' | 'request_changes' | 'escalate'

export interface ParsedRubricVerdict {
  verdict: RubricVerdict
  reason?: string
}

const MAX_RUBRIC_DIFF_CHARS = 60_000

/**
 * Parse the reviewer's free-text reply into a structured verdict. The reviewer
 * is contracted (via the prompt) to end with `VERDICT: <…>`; the LAST
 * occurrence wins so a model restating the instructions still resolves to its
 * final choice. Null (no marker) is escalated by the caller — never a silent
 * pass.
 */
export function parseRubricVerdict(text: string): ParsedRubricVerdict | null {
  const matches = [...text.matchAll(/VERDICT:\s*(approve|request_changes|escalate)/gi)]
  if (!matches.length) return null
  const last = matches[matches.length - 1]
  const verdict = last[1].toLowerCase() as RubricVerdict
  const after = text.slice(last.index + last[0].length)
  const reasonMatch = after.match(/REASON:\s*(.+)/i)
  return reasonMatch ? { verdict, reason: reasonMatch[1].trim() } : { verdict }
}

export function buildRubricPrompt(opts: {
  recipeName: string
  goal: string
  passedCommands: string[]
  diff: string
  instructions?: string
}): string {
  const body = opts.diff.length > MAX_RUBRIC_DIFF_CHARS ? `${opts.diff.slice(0, MAX_RUBRIC_DIFF_CHARS)}\n... [diff truncated]` : opts.diff
  const lines = [
    `# Loop Run Review: ${opts.recipeName}`,
    '',
    `## Outcome being pursued`,
    opts.goal,
    '',
    `## Deterministic verification`,
    'These commands already PASSED on this change:',
    ...opts.passedCommands.map((c) => `- \`${c}\``),
    '',
    `## Your job`,
    'Review the diff below as an independent reviewer. Confirm it genuinely achieves the outcome and does NOT:',
    '- weaken, skip, or delete tests to make verification pass',
    '- introduce unsafe, incorrect, or out-of-scope changes',
    'You are reviewing only — do not modify any files.',
  ]
  if (opts.instructions) lines.push('', `## Additional review guidance`, opts.instructions)
  lines.push(
    '',
    `## Diff`,
    '```diff',
    body,
    '```',
    '',
    `## Required response`,
    'End your reply with exactly one verdict line:',
    '- `VERDICT: approve` — correct and ready to land',
    '- `VERDICT: request_changes` then a `REASON:` line stating what must change',
    '- `VERDICT: escalate` then a `REASON:` line when a human must decide',
  )
  return lines.join('\n')
}

/** Config type re-export for engine convenience. */
export type { CommandEvaluatorConfig, RubricEvaluatorConfig }

// ---------------------------------------------------------------------------
// Git helpers (argv-only, no shell)
// ---------------------------------------------------------------------------

/** `git diff --stat` vs HEAD — the material-progress signal and diff summary. */
export async function getDiffSummary(cwd: string): Promise<string> {
  const out = await execGit(['diff', '--stat', 'HEAD'], cwd)
  return out.trimEnd()
}

/** Full working-tree patch vs HEAD — travels in the rubric prompt. */
export async function getDiff(cwd: string): Promise<string> {
  const out = await execGit(['diff', 'HEAD'], cwd)
  return out.trimEnd()
}

/** Changed files vs HEAD — input to protected-path enforcement. */
export async function getChangedFiles(cwd: string): Promise<string[]> {
  const out = await execGit(['diff', '--name-only', 'HEAD'], cwd)
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}
