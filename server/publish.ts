/**
 * Publish a session's folder to GitHub: the **Publish to GitHub…** action
 * of the Keep this work? callout (session-start phase 3).
 *
 * `git init` if needed, commit everything as "Initial commit", then
 * `gh repo create <owner>/<name> --private|--public --source . --push` with
 * the machine's gh login. The user's click is the consent, as with clone and
 * git-init. The folder stays where it is.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { isGitWorkTree, isValidOwner } from './places.js'

const execFileAsync = promisify(execFile)

export interface PublishInput {
  owner: string
  name: string
  visibility: 'private' | 'public'
}

/** GitHub repository names: letters, digits, `.`, `-`, `_`; up to 100; not `.` or `..`. */
const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/

export function validatePublishInput(body: unknown): { ok: true; input: PublishInput } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>
  const owner = typeof b.owner === 'string' ? b.owner.trim() : ''
  const name = typeof b.name === 'string' ? b.name.trim() : ''
  if (!isValidOwner(owner)) return { ok: false, error: 'Choose a GitHub owner' }
  if (!REPO_NAME_RE.test(name) || name === '.' || name === '..' || name.endsWith('.git')) {
    return { ok: false, error: 'Repository names use letters, digits, ".", "-" and "_"' }
  }
  const visibility = b.visibility === 'public' ? 'public' : 'private'
  return { ok: true, input: { owner, name, visibility } }
}

export type Runner = (cmd: string, args: string[], opts: { cwd: string; timeout: number; env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string }>

const defaultRunner: Runner = async (cmd, args, opts) => {
  const { stdout } = await execFileAsync(cmd, args, { ...opts, maxBuffer: 4 * 1024 * 1024 })
  return { stdout }
}

/** gh uses its own login, not a GITHUB_TOKEN that might be in the server's environment. */
function ghEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.GITHUB_TOKEN
  return env
}

function failure(step: string, err: unknown): Error {
  const stderr = (err as { stderr?: string }).stderr?.trim()
  const message = stderr || (err instanceof Error ? err.message : String(err))
  if (/Please tell me who you are|user\.email/i.test(message)) {
    return new Error('git needs your name and email before it can commit: run `git config --global user.name "…"` and `git config --global user.email "…"` on the machine, then try again.')
  }
  return new Error(`${step} failed: ${message}`)
}

/** Publish `root` (already bounds-checked); returns the repository URL. */
export async function publishFolder(root: string, input: PublishInput, run: Runner = defaultRunner): Promise<{ url: string }> {
  const git = (args: string[], step: string) => run('git', args, { cwd: root, timeout: 30_000 }).catch((err: unknown) => { throw failure(step, err) })

  if (!isGitWorkTree(root)) await git(['init'], 'git init')
  const remotes = (await git(['remote'], 'git remote')).stdout.split('\n').map(r => r.trim())
  if (remotes.includes('origin')) throw new Error('This folder already has a remote named origin.')
  const status = (await git(['status', '--porcelain'], 'git status')).stdout.trim()
  if (status) {
    await git(['add', '-A'], 'git add')
    await git(['commit', '-q', '-m', 'Initial commit'], 'git commit')
  }
  try {
    await run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, timeout: 10_000 })
  } catch {
    throw new Error('Nothing to publish yet: the folder is empty.')
  }

  const full = `${input.owner}/${input.name}`
  let stdout: string
  try {
    stdout = (await run('gh', ['repo', 'create', full, `--${input.visibility}`, '--source', '.', '--remote', 'origin', '--push'], {
      cwd: root, timeout: 120_000, env: ghEnv(),
    })).stdout
  } catch (err) {
    throw failure('gh repo create', err)
  }
  const url = stdout.match(/https:\/\/\S+/)?.[0] ?? `https://github.com/${full}`
  return { url }
}
