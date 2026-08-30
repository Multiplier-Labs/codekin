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
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, sep } from 'path'
import { execGit } from './diff-manager.js'
import { matchesAnyGlob } from './glob-match.js'
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
// Test-report evaluator — command + failing-test parsing
// ---------------------------------------------------------------------------

export interface ParsedTestReport {
  /** Identities of failing tests (suite/file + name where available). */
  failing: string[]
  /** Counts when the format reports them; null when not stated. */
  passedCount: number | null
  failedCount: number | null
}

/** Vitest/Jest-style stdout: `✗`/`×`/`FAIL` lines plus the summary counts. */
export function parseVitestOutput(text: string): ParsedTestReport {
  const failing: string[] = []
  for (const m of text.matchAll(/^\s*(?:✗|×|✘|FAIL {2}|❯?\s*✖)\s+(.+?)\s*(?:\(\d+ tests?.*\))?\s*(?:\d+m?s)?$/gm)) {
    const name = m[1].trim()
    if (name && !failing.includes(name)) failing.push(name)
  }
  // "Tests  2 failed | 40 passed (42)" (vitest) or "Tests: 1 failed, 5 passed"
  const failed = text.match(/Tests[:\s]+.*?(\d+)\s+failed/i)
  const passed = text.match(/(\d+)\s+passed/i)
  return {
    failing,
    passedCount: passed ? Number(passed[1]) : null,
    failedCount: failed ? Number(failed[1]) : null,
  }
}

/** TAP: `not ok N - name` lines plus the `1..N` plan. */
export function parseTapOutput(text: string): ParsedTestReport {
  const failing: string[] = []
  let ok = 0
  for (const m of text.matchAll(/^(not )?ok\b\s*\d*\s*(?:-\s*)?(.*)$/gm)) {
    if (m[1]) failing.push(m[2].trim() || `test ${failing.length + 1}`)
    else ok += 1
  }
  return { failing, passedCount: ok, failedCount: failing.length }
}

/** JUnit XML: `<testcase>` elements containing `<failure>`/`<error>`. */
export function parseJunitXml(xml: string): ParsedTestReport {
  const failing: string[] = []
  let total = 0
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    total += 1
    const attrs = m[1]
    const body = m[2] ?? ''
    if (/<(failure|error)\b/.test(body)) {
      // (?:^|\s) guards against matching the tail of `classname="…"`.
      const name = /(?:^|\s)name="([^"]*)"/.exec(attrs)?.[1] ?? `testcase ${total}`
      const classname = /(?:^|\s)classname="([^"]*)"/.exec(attrs)?.[1]
      failing.push(classname ? `${classname} > ${name}` : name)
    }
  }
  return { failing, passedCount: total - failing.length, failedCount: failing.length }
}

export function parseTestReport(parser: 'vitest' | 'tap' | 'junit-xml', content: string): ParsedTestReport {
  switch (parser) {
    case 'vitest': return parseVitestOutput(content)
    case 'tap': return parseTapOutput(content)
    case 'junit-xml': return parseJunitXml(content)
  }
}

/**
 * Run a test-report evaluator: execute the command, then parse failing tests
 * from stdout (or the report file for junit-xml). The fingerprint hashes the
 * failing-test identities — far stabler across runs than raw output — and the
 * summary/tail name the failures directly.
 */
export async function runTestReportEvaluator(
  config: import('./loop-recipe.js').TestReportEvaluatorConfig,
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<CommandEvaluationOutcome> {
  const startedAt = Date.now()
  const raw = await execCommand(config.command, cwd, config.timeoutMs, { ...process.env, ...(env ?? {}) })
  const durationMs = Date.now() - startedAt
  const command = displayCommand(config.command)

  const environmental = raw.timedOut || raw.spawnError !== null
  if (environmental) {
    const outputTail = tail(raw.output)
    return {
      evaluatorId: config.id,
      status: 'error',
      classification: 'environment',
      summary: raw.timedOut ? `\`${command}\` timed out after ${Math.round(config.timeoutMs / 1000)}s` : `\`${command}\` could not start: ${raw.spawnError ?? ''}`,
      outputTail,
      fullOutput: raw.output,
      command,
      exitCode: raw.exitCode,
      fingerprint: failureFingerprint(config.id, raw.exitCode, outputTail),
      retryable: true,
      durationMs,
      timedOut: raw.timedOut,
    }
  }

  let source = raw.output
  if (config.parser === 'junit-xml' && config.reportPath) {
    try {
      source = readFileSync(join(cwd, config.reportPath), 'utf-8')
    } catch {
      // Missing report + nonzero exit = ordinary failure; with exit 0 it is an
      // environment problem (the runner claims success but produced no report).
      if (raw.exitCode === 0) {
        return {
          evaluatorId: config.id,
          status: 'error',
          classification: 'environment',
          summary: `\`${command}\` exited 0 but wrote no report at ${config.reportPath}`,
          outputTail: tail(raw.output),
          fullOutput: raw.output,
          command,
          exitCode: raw.exitCode,
          fingerprint: failureFingerprint(config.id, raw.exitCode, config.reportPath),
          retryable: true,
          durationMs,
          timedOut: false,
        }
      }
      source = raw.output
    }
  }

  const report = parseTestReport(config.parser, source)
  const passed = raw.exitCode === 0 && report.failing.length === 0
  if (passed) {
    const counts = report.passedCount !== null ? ` (${report.passedCount} tests)` : ''
    return {
      evaluatorId: config.id,
      status: 'pass',
      classification: null,
      summary: `\`${command}\` passed${counts}`,
      outputTail: tail(raw.output),
      fullOutput: raw.output,
      command,
      exitCode: 0,
      fingerprint: null,
      retryable: false,
      durationMs,
      timedOut: false,
    }
  }

  const shown = report.failing.slice(0, 5)
  const summary = report.failing.length
    ? `${report.failedCount ?? report.failing.length} test(s) failing: ${shown.join(', ')}${report.failing.length > shown.length ? ', …' : ''}`
    : `\`${command}\` exited ${raw.exitCode}`
  const fingerprint = report.failing.length
    ? createHash('sha256').update(`${config.id}\0${[...report.failing].sort().join('\n')}`).digest('hex')
    : failureFingerprint(config.id, raw.exitCode, tail(raw.output))
  return {
    evaluatorId: config.id,
    status: 'fail',
    classification: report.failing.length ? 'test' : 'code',
    summary,
    outputTail: report.failing.length ? `Failing tests:\n${report.failing.map((f) => `- ${f}`).join('\n')}\n\n${tail(raw.output, 30)}` : tail(raw.output),
    fullOutput: raw.output,
    command,
    exitCode: raw.exitCode,
    fingerprint,
    retryable: false,
    durationMs,
    timedOut: false,
  }
}

// ---------------------------------------------------------------------------
// Diff-policy evaluator — deterministic checks over the diff itself
// ---------------------------------------------------------------------------

export interface DiffPolicyViolation {
  rule: 'max-changed-files' | 'max-changed-lines' | 'forbidden-path' | 'test-weakening' | 'secret'
  detail: string
}

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'AWS access key', pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'private key block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'GitHub token', pattern: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: 'generic secret assignment', pattern: /(?:api[_-]?key|secret|token|password)["'\s]*[:=]\s*["'][A-Za-z0-9+/_-]{20,}["']/i },
]

const TEST_FILE_PATTERN = /(\.(test|spec)\.[jt]sx?$|(^|\/)tests?\/|(^|\/)__tests__\/)/
const WEAKENING_ADDITION = /\.(skip|only|todo)\s*\(|\bx(it|describe|test)\s*\(/

/**
 * Analyze a unified diff against the policy. Pure; the caller supplies the
 * diff text and the changed-file list.
 */
export function analyzeDiffPolicy(
  config: import('./loop-recipe.js').DiffPolicyEvaluatorConfig,
  diff: string,
  changedFiles: string[],
): DiffPolicyViolation[] {
  const violations: DiffPolicyViolation[] = []

  if (config.maxChangedFiles !== undefined && changedFiles.length > config.maxChangedFiles) {
    violations.push({ rule: 'max-changed-files', detail: `${changedFiles.length} files changed (max ${config.maxChangedFiles})` })
  }

  const addedLines: Array<{ file: string; line: string }> = []
  const deletedFiles: string[] = []
  let currentFile = ''
  let changedLines = 0
  for (const line of diff.split('\n')) {
    const fileMatch = /^\+\+\+ b\/(.+)$/.exec(line)
    if (fileMatch) {
      currentFile = fileMatch[1]
      continue
    }
    const deleted = /^deleted file mode/.test(line)
    if (deleted) {
      // The `--- a/<file>` line follows; capture on the next header instead.
    }
    const delHeader = /^--- a\/(.+)$/.exec(line)
    if (delHeader) currentFile = delHeader[1]
    if (/^\+[^+]/.test(line) || /^-[^-]/.test(line)) changedLines += 1
    if (/^\+[^+]/.test(line)) addedLines.push({ file: currentFile, line: line.slice(1) })
  }
  for (const m of diff.matchAll(/^diff --git a\/(.+?) b\/.+\ndeleted file mode/gm)) deletedFiles.push(m[1])

  if (config.maxChangedLines !== undefined && changedLines > config.maxChangedLines) {
    violations.push({ rule: 'max-changed-lines', detail: `${changedLines} lines changed (max ${config.maxChangedLines})` })
  }

  if (config.forbidPaths.length) {
    for (const file of changedFiles) {
      if (matchesAnyGlob(file, config.forbidPaths)) {
        violations.push({ rule: 'forbidden-path', detail: `changed forbidden path ${file}` })
      }
    }
  }

  if (config.noTestWeakening) {
    for (const file of deletedFiles) {
      if (TEST_FILE_PATTERN.test(file)) violations.push({ rule: 'test-weakening', detail: `test file deleted: ${file}` })
    }
    for (const { file, line } of addedLines) {
      if (TEST_FILE_PATTERN.test(file) && WEAKENING_ADDITION.test(line)) {
        violations.push({ rule: 'test-weakening', detail: `${file}: added ${line.trim().slice(0, 80)}` })
      }
    }
  }

  if (config.secretScan) {
    for (const { file, line } of addedLines) {
      for (const { name, pattern } of SECRET_PATTERNS) {
        if (pattern.test(line)) {
          violations.push({ rule: 'secret', detail: `${file}: possible ${name}` })
          break
        }
      }
    }
  }

  return violations
}

// ---------------------------------------------------------------------------
// Artifact evaluator — a file the run must produce
// ---------------------------------------------------------------------------

/** Check the required artifact exists (glob allowed) and meets the size floor. */
export function checkArtifactRequirement(
  config: import('./loop-recipe.js').ArtifactEvaluatorConfig,
  cwd: string,
): { ok: boolean; detail: string } {
  let entries: string[]
  try {
    // node_modules and .git would dominate a recursive walk; a loop worktree
    // is otherwise small, and artifact paths are authored to be shallow.
    entries = (readdirSync(cwd, { recursive: true }) as string[])
      .map((p) => p.split(sep).join('/'))
      .filter((p) => !p.startsWith('node_modules/') && !p.startsWith('.git/'))
  } catch (err) {
    return { ok: false, detail: `could not scan the worktree: ${err instanceof Error ? err.message : String(err)}` }
  }
  const matches = entries.filter((p) => matchesAnyGlob(p, [config.path]))
  if (!matches.length) return { ok: false, detail: `no file matches ${config.path}` }
  for (const match of matches) {
    try {
      const stat = statSync(join(cwd, match))
      if (stat.isFile() && stat.size >= config.minBytes) return { ok: true, detail: `${match} (${stat.size} bytes)` }
    } catch {
      // raced deletion — keep looking
    }
  }
  return { ok: false, detail: `matches for ${config.path} are all smaller than ${config.minBytes} bytes` }
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
