/**
 * Deterministic verifier for Goal Runs.
 *
 * This is the cheap, objective gate that runs BEFORE any model-based checker:
 * run the loop's verify commands (e.g. `npm test`, `npm run lint`) in the run's
 * worktree, capture each command's exit code and a tail of its output, and report
 * pass/fail. The controller uses this to decide whether to feed a failure back to
 * the maker, invoke the checker, or finalize.
 *
 * It also exposes two git helpers the controller needs:
 *   - getDiffSummary  → `git diff --stat` (debounce signal + evidence ledger entry)
 *   - getChangedFiles → `git diff --name-only` (readonly-glob constraint enforcement)
 *
 * Verify commands are authored by the repo owner (loop template / API), exactly
 * like package.json scripts or a CI config — they are trusted and run through a
 * shell. Git commands run argv-only (no shell) via the diff-manager helper.
 */

import { exec } from 'child_process'
import { execGit } from './diff-manager.js'

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes per command
const DEFAULT_TAIL_LINES = 50
const MAX_BUFFER = 16 * 1024 * 1024 // 16 MB

export interface VerifyCommandResult {
  command: string
  exitCode: number
  /** Combined stdout+stderr, trimmed to the last `tailLines` lines. */
  outputTail: string
  durationMs: number
  timedOut: boolean
}

export interface VerifyResult {
  /** True only if every command exited 0. */
  passed: boolean
  results: VerifyCommandResult[]
}

export interface VerifierOptions {
  /** Worktree directory the commands run in. */
  cwd: string
  /** Shell commands, executed in order. */
  commands: string[]
  /** Per-command timeout. Defaults to 10 minutes. */
  timeoutMs?: number
  /** Lines of output to retain per command. Defaults to 50. */
  tailLines?: number
  /** Extra environment for the commands (merged over process.env). */
  env?: NodeJS.ProcessEnv
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

function tail(text: string, lines: number): string {
  // Trim trailing newlines first: otherwise a final '\n' yields an empty last
  // element that would displace a real line out of the tail window.
  const trimmed = text.trimEnd()
  const split = trimmed.split('\n')
  if (split.length <= lines) return trimmed
  return split.slice(split.length - lines).join('\n')
}

/** Run a single shell command, capturing exit code + output regardless of success. */
function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  tailLines: number,
  env: NodeJS.ProcessEnv,
): Promise<VerifyCommandResult> {
  const startedAt = Date.now()
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: timeoutMs, maxBuffer: MAX_BUFFER, env }, (err, stdout, stderr) => {
      const durationMs = Date.now() - startedAt
      const combined = `${stdout}${stderr}`
      if (!err) {
        resolve({ command, exitCode: 0, outputTail: tail(combined, tailLines), durationMs, timedOut: false })
        return
      }
      const failure: ExecFailure = isExecFailure(err) ? err : {}
      const timedOut = failure.killed === true && failure.signal === 'SIGTERM'
      // exec surfaces the real exit code on `.code`; fall back to 1 when the
      // process was killed (timeout) or no code is available.
      const exitCode = typeof failure.code === 'number' ? failure.code : 1
      const out = `${failure.stdout ?? stdout}${failure.stderr ?? stderr}`
      resolve({ command, exitCode, outputTail: tail(out, tailLines), durationMs, timedOut })
    })
  })
}

/**
 * Run the verify commands in order, short-circuiting on the first failure.
 * Short-circuit keeps cost down: there is no point linting code whose tests
 * already failed, and the first failure is what the maker needs to see next.
 */
export async function runVerifier(opts: VerifierOptions): Promise<VerifyResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const tailLines = opts.tailLines ?? DEFAULT_TAIL_LINES
  const env = { ...process.env, ...(opts.env ?? {}) }
  const results: VerifyCommandResult[] = []
  for (const command of opts.commands) {
    const result = await runCommand(command, opts.cwd, timeoutMs, tailLines, env)
    results.push(result)
    if (result.exitCode !== 0) {
      return { passed: false, results }
    }
  }
  return { passed: true, results }
}

/**
 * `git diff --stat` of the working tree against HEAD. Doubles as the debounce
 * signal (unchanged stat since last verify ⇒ skip re-running) and the diff
 * summary recorded in the evidence ledger.
 */
export async function getDiffSummary(cwd: string): Promise<string> {
  const out = await execGit(['diff', '--stat', 'HEAD'], cwd)
  return out.trimEnd()
}

/** Files changed in the working tree vs HEAD — input to readonly-glob enforcement. */
export async function getChangedFiles(cwd: string): Promise<string[]> {
  const out = await execGit(['diff', '--name-only', 'HEAD'], cwd)
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}
