/**
 * The org manifest: what an org session's agent is told about where it is.
 *
 * An org session runs in `REPOS_ROOT/<owner>`, the folder that owner's clones
 * land in. The manifest is prefixed to the session's first message, the same
 * way a handoff is, so it reaches every harness without per-harness system
 * prompt plumbing. It is built from disk only (no GitHub call), so creating
 * the session never waits on the network; the agent lists the rest itself.
 *
 * Cloning and worktrees are conventions the agent follows with ordinary shell
 * commands, under the normal approval prompt: clones go to `./<name>` (the
 * layout Codekin's repo list reads), worktrees to `./<name>-wt-<id8>` on the
 * session's branch (the layout Codekin's own worktrees use).
 */

import { readdirSync } from 'fs'
import { join } from 'path'
import { isGitWorkTree } from './places.js'

/** Most cloned repos named in the manifest; beyond that the agent lists the folder. */
const MAX_LISTED = 200

/** A Codekin-managed worktree folder: `<name>-wt-<8 hex>`. */
const WORKTREE_DIR_RE = /-wt-[0-9a-f]{8}$/

export interface OrgManifestInput {
  owner: string
  /** The org folder, `REPOS_ROOT/<owner>`. */
  dir: string
  sessionId: string
  /** Isolate edits in one worktree per repository. */
  worktrees: boolean
  /** Branch prefix for session worktrees (Settings), e.g. `wt/`. */
  branchPrefix: string
}

/** Repositories cloned in the org folder (not worktrees), sorted. Exported for tests. */
export function clonedRepos(dir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name)
  } catch {
    return []
  }
  return names
    .filter(name => !WORKTREE_DIR_RE.test(name) && isGitWorkTree(join(dir, name)))
    .sort((a, b) => a.localeCompare(b))
}

export function buildOrgManifest(input: OrgManifestInput): string {
  const { owner, dir, sessionId, worktrees, branchPrefix } = input
  const id8 = sessionId.slice(0, 8)
  const branch = `${branchPrefix}${id8}`
  const cloned = clonedRepos(dir)
  const listed = cloned.slice(0, MAX_LISTED)
  const more = cloned.length - listed.length

  const lines = [
    '<codekin-org-session>',
    `This session works across the GitHub owner "${owner}". The working directory is ${dir};`,
    'each of its repositories is, or can be, cloned into a subfolder named after it.',
    '',
    cloned.length
      ? `Cloned already (${cloned.length}): ${listed.join(', ')}${more > 0 ? `, and ${more} more (list the folder)` : ''}.`
      : 'No repositories are cloned yet.',
    `To see every repository: gh repo list ${owner} --limit 1000 --json name,description`,
    `To clone one you need, from the working directory: gh repo clone ${owner}/<name>`,
    'Clone only what the task needs, and say which repositories you cloned.',
    '',
  ]
  if (worktrees) {
    lines.push(
      'Keep the clones clean: before your first change in a repository, give it a worktree for this session',
      `and work there: git -C <name> worktree add ../<name>-wt-${id8} -b ${branch}`,
      `If that worktree already exists, use it. Reading and searching can use the clones directly.`,
    )
  } else {
    lines.push('Edit the clones in place, on the branch each has checked out, unless the user asks for a branch.')
  }
  lines.push('</codekin-org-session>')
  return lines.join('\n')
}
