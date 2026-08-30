/**
 * Shared tool allowlists for autonomous agent sessions.
 *
 * Both orchestrator child sessions and loop-run maker sessions run headless:
 * a tool call that falls through to manual approval blocks the session until a
 * human notices. These curated lists cover standard dev operations without
 * granting arbitrary shell access, so a headless agent can do real work while
 * destructive commands (rm, sudo, docker, git reset/clean, git push --force)
 * still require explicit approval.
 */

/** Default allowed tools for headless agent sessions that write code. */
export const AGENT_ALLOWED_TOOLS = [
  // File operations (scoped to working dir by acceptEdits mode)
  'Read', 'Glob', 'Grep', 'Write', 'Edit',
  // Git operations (branch, commit, push, PR workflow)
  'Bash(git:*)',
  // GitHub CLI (create PRs, check runs, etc.)
  'Bash(gh:*)',
  // API calls (status reporting back to orchestrator)
  'Bash(curl:*)',
  // Package managers
  'Bash(npm:*)', 'Bash(npx:*)', 'Bash(yarn:*)', 'Bash(pnpm:*)', 'Bash(bun:*)',
  // Build / lint / test tools
  'Bash(node:*)', 'Bash(tsc:*)', 'Bash(eslint:*)', 'Bash(prettier:*)',
  'Bash(cargo:*)', 'Bash(go:*)', 'Bash(make:*)', 'Bash(pip:*)',
  // Python toolchain (linting/tests in Python repos)
  'Bash(python3:*)', 'Bash(pytest:*)',
  // Text/data processing (read-only or scoped to working dir)
  'Bash(sed:*)', 'Bash(rg:*)', 'Bash(jq:*)',
  // Non-destructive file management (no rm — deletion still needs approval)
  'Bash(mkdir:*)', 'Bash(cp:*)', 'Bash(mv:*)', 'Bash(touch:*)',
  // Safe filesystem inspection (read-only)
  'Bash(ls:*)', 'Bash(cat:*)', 'Bash(wc:*)',
  'Bash(head:*)', 'Bash(tail:*)', 'Bash(sort:*)', 'Bash(diff:*)',
  'Bash(basename:*)', 'Bash(dirname:*)',
  'Bash(realpath:*)', 'Bash(tree:*)', 'Bash(pwd:*)',
  'Bash(which:*)', 'Bash(file:*)',
]

/**
 * Allowed tools for review-only agent sessions (e.g. a loop-run rubric reviewer).
 * Reading and inspection only — a reviewer that suddenly needs Write has left
 * its mandate, and that is exactly the moment a human should be asked.
 */
export const READONLY_AGENT_ALLOWED_TOOLS = [
  'Read', 'Glob', 'Grep',
  'Bash(git:*)',
  'Bash(rg:*)', 'Bash(jq:*)',
  'Bash(ls:*)', 'Bash(cat:*)', 'Bash(wc:*)',
  'Bash(head:*)', 'Bash(tail:*)', 'Bash(sort:*)', 'Bash(diff:*)',
  'Bash(basename:*)', 'Bash(dirname:*)',
  'Bash(realpath:*)', 'Bash(tree:*)', 'Bash(pwd:*)',
  'Bash(which:*)', 'Bash(file:*)',
]
