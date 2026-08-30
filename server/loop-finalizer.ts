/**
 * Deterministic finalization for a passing loop run.
 *
 * When evaluation passes (and any required approval is granted), Codekin —
 * not the maker agent — lands the verified tree: commit any uncommitted
 * changes (so what passed evaluation is exactly what ships), then per the
 * completion action push the branch and open a pull request.
 *
 * Push / PR failures are *reported* in the returned note but never thrown:
 * evaluation already passed, so the run still completes — the branch sits
 * locally and a human can push it by hand. `prUrl` stays null so "completed
 * but no PR" is visible rather than mistaken for "merge-ready".
 *
 * Finalization is safe to re-run after a crash: a clean tree commits nothing,
 * push is idempotent, and an already-open PR for the branch is recovered
 * rather than duplicated.
 *
 * All git/gh shell-outs run as fixed argv arrays (no shell interpolation) and
 * are injectable for tests.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { execGit } from './diff-manager.js'
import type { CompletionAction } from './loop-recipe.js'

const execFileAsync = promisify(execFile)
const GH_TIMEOUT_MS = 30_000

export interface FinalizeOptions {
  /** Worktree path the run executed in. */
  cwd: string
  /** Branch the maker worked on (the PR head). */
  branch: string
  action: CompletionAction
  /** PR / commit title. */
  title: string
  /** PR body (ignored for non-PR actions). */
  body: string
}

export interface FinalizeResult {
  /** The opened (or recovered) PR URL, or null when none. */
  prUrl: string | null
  /** Human-readable outcome recorded in the event stream. */
  note: string
  /** False when a step after evaluation failed (commit/push/PR) — qualifies the outcome. */
  clean: boolean
}

export interface LoopFinalizerApi {
  finalize(opts: FinalizeOptions): Promise<FinalizeResult>
}

type CmdRunner = (args: string[], cwd: string) => Promise<string>

const realGit: CmdRunner = (args, cwd) => execGit(args, cwd)
const realGh: CmdRunner = async (args, cwd) => {
  const { stdout } = await execFileAsync('gh', args, { cwd, timeout: GH_TIMEOUT_MS })
  return stdout
}

let gitRunner: CmdRunner = realGit
let ghRunner: CmdRunner = realGh

/** @internal Test-only: override the git/gh runners. */
export function _setLoopFinalizerRunners(git: CmdRunner, gh: CmdRunner): void {
  gitRunner = git
  ghRunner = gh
}

/** @internal Test-only: restore the real git/gh runners. */
export function _resetLoopFinalizerRunners(): void {
  gitRunner = realGit
  ghRunner = realGh
}

export const defaultLoopFinalizer: LoopFinalizerApi = {
  async finalize(opts: FinalizeOptions): Promise<FinalizeResult> {
    const { cwd, branch, action, title, body } = opts

    try {
      await commitIfDirty(cwd, title)
    } catch (err) {
      return { prUrl: null, note: `Evaluation passed; commit failed: ${errMsg(err)}`, clean: false }
    }

    if (action === 'commit-only') {
      return { prUrl: null, note: 'Evaluation passed; changes committed locally (no push).', clean: true }
    }

    try {
      await gitRunner(['push', '-u', 'origin', branch], cwd)
    } catch (err) {
      return { prUrl: null, note: `Evaluation passed; committed but push failed: ${errMsg(err)}`, clean: false }
    }

    try {
      const out = await ghRunner(['pr', 'create', '--head', branch, '--title', title, '--body', body], cwd)
      const prUrl = extractPrUrl(out)
      return prUrl
        ? { prUrl, note: `Evaluation passed; opened PR: ${prUrl}`, clean: true }
        : { prUrl: null, note: `Evaluation passed; pushed branch ${branch} (PR URL not parsed).`, clean: false }
    } catch (err) {
      // A PR may already exist for this branch (a re-run, or finalize re-running
      // after a crash) — recover its URL rather than reporting a failure.
      const existing = await existingPrUrl(branch, cwd)
      if (existing) return { prUrl: existing, note: `Evaluation passed; PR already open: ${existing}`, clean: true }
      return { prUrl: null, note: `Evaluation passed; branch pushed but PR creation failed: ${errMsg(err)}`, clean: false }
    }
  },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function commitIfDirty(cwd: string, title: string): Promise<void> {
  const status = await gitRunner(['status', '--porcelain'], cwd)
  if (!status.trim()) return
  await gitRunner(['add', '-A'], cwd)
  await gitRunner(['commit', '-m', title], cwd)
}

async function existingPrUrl(branch: string, cwd: string): Promise<string | null> {
  try {
    const out = await ghRunner(['pr', 'view', branch, '--json', 'url', '-q', '.url'], cwd)
    return extractPrUrl(out)
  } catch {
    return null
  }
}

function extractPrUrl(output: string): string | null {
  const match = output.match(/https?:\/\/\S+\/pull\/\d+/)
  return match ? match[0] : null
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
