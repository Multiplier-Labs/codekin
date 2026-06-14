/**
 * Deterministic finalization for a verified GoalRun.
 *
 * When the deterministic verifier passes, Codekin — not the maker agent — lands
 * the verified tree. We commit any uncommitted changes (so what passed
 * verification is exactly what ships), then, per the completion policy, push the
 * branch and open a pull request, capturing the PR URL.
 *
 * Push / PR failures are *reported* in the returned note but never thrown:
 * verification already passed, so the run still succeeds — the branch is sitting
 * locally and a human can push it by hand. The controller surfaces the note in
 * the evidence ledger and leaves `prUrl` null so "succeeded but no PR" is visible
 * rather than silently mistaken for "merged-ready".
 *
 * All git/gh shell-outs run as fixed argv arrays (no shell interpolation) and are
 * injectable for tests.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { execGit } from './diff-manager.js'
import type { CompletionPolicy } from './goal-run-store.js'

const execFileAsync = promisify(execFile)
const GH_TIMEOUT_MS = 30_000

export interface FinalizeOptions {
  /** Worktree path the run executed in. */
  cwd: string
  /** Branch the maker worked on (the PR head). */
  branch: string
  policy: CompletionPolicy
  /** PR / commit title. */
  title: string
  /** PR body (ignored for non-'pr' policies). */
  body: string
}

export interface FinalizeResult {
  /** The opened PR URL, or null when no PR was opened (policy or failure). */
  prUrl: string | null
  /** Human-readable outcome recorded in the evidence ledger. */
  note: string
}

export interface FinalizerApi {
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
export function _setFinalizerRunners(git: CmdRunner, gh: CmdRunner): void {
  gitRunner = git
  ghRunner = gh
}

/** @internal Test-only: restore the real git/gh runners. */
export function _resetFinalizerRunners(): void {
  gitRunner = realGit
  ghRunner = realGh
}

export const defaultFinalizer: FinalizerApi = {
  async finalize(opts: FinalizeOptions): Promise<FinalizeResult> {
    const { cwd, branch, policy, title, body } = opts

    try {
      await commitIfDirty(cwd, title)
    } catch (err) {
      return { prUrl: null, note: `Verification passed; commit failed: ${errMsg(err)}` }
    }

    if (policy === 'commit-only') {
      return { prUrl: null, note: 'Verification passed; changes committed locally (no push).' }
    }

    try {
      await gitRunner(['push', '-u', 'origin', branch], cwd)
    } catch (err) {
      return { prUrl: null, note: `Verification passed; committed but push failed: ${errMsg(err)}` }
    }

    if (policy === 'merge') {
      return { prUrl: null, note: `Verification passed; pushed branch ${branch} (no PR).` }
    }

    // policy === 'pr'
    try {
      const out = await ghRunner(['pr', 'create', '--head', branch, '--title', title, '--body', body], cwd)
      const prUrl = extractPrUrl(out)
      return prUrl
        ? { prUrl, note: `Verification passed; opened PR: ${prUrl}` }
        : { prUrl: null, note: `Verification passed; pushed branch ${branch} (PR URL not parsed).` }
    } catch (err) {
      // A PR may already exist for this branch (e.g. a re-run on the same branch);
      // recover its URL rather than reporting a failure.
      const existing = await existingPrUrl(branch, cwd)
      if (existing) return { prUrl: existing, note: `Verification passed; PR already open: ${existing}` }
      return { prUrl: null, note: `Verification passed; branch pushed but PR creation failed: ${errMsg(err)}` }
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
