import { execFile } from 'child_process'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 120_000

/**
 * Environment override that injects the gh credential helper for git HTTPS auth.
 * Applied only to webhook workspace git commands — does not modify global git config.
 *
 * This is needed because `gh repo clone` handles auth internally, but subsequent
 * `git fetch` / `git push` commands use plain git which has no credential helper
 * configured by default.
 */
const GIT_AUTH_ENV = {
  ...process.env,
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
  GIT_CONFIG_VALUE_0: '!/usr/bin/gh auth git-credential',
}

const BASE_DIR = join(homedir(), '.codekin')
const REPOS_DIR = join(BASE_DIR, 'repos')
const WORKSPACES_DIR = join(BASE_DIR, 'workspaces')

/** In-memory lock to prevent concurrent bare mirror clones for the same repo. */
const mirrorLocks = new Map<string, Promise<string>>()

/**
 * Ensure a bare mirror of the repo exists at ~/.codekin/repos/{owner}/{repo}.git
 * If it doesn't exist, clone it using `gh repo clone --bare`.
 *
 * Uses an in-memory lock per repo to prevent concurrent clones from corrupting
 * the git database when multiple webhooks for the same repo arrive simultaneously.
 */
async function ensureBareMirror(repo: string): Promise<string> {
  // If another call is already cloning this repo, wait for it
  const existing = mirrorLocks.get(repo)
  if (existing) {
    return existing
  }

  const promise = ensureBareMirrorImpl(repo).finally(() => {
    mirrorLocks.delete(repo)
  })
  mirrorLocks.set(repo, promise)
  return promise
}

async function ensureBareMirrorImpl(repo: string): Promise<string> {
  const mirrorPath = resolve(join(REPOS_DIR, `${repo}.git`))
  if (!mirrorPath.startsWith(REPOS_DIR + '/')) {
    throw new Error(`Path traversal detected: repo '${repo}' escapes REPOS_DIR`)
  }

  if (existsSync(mirrorPath)) {
    // Update the mirror
    try {
      await execFileAsync('git', ['fetch', '--all', '--prune'], {
        cwd: mirrorPath,
        timeout: GIT_TIMEOUT_MS,
        env: GIT_AUTH_ENV,
      })
    } catch (err) {
      console.warn(`[webhook-workspace] Failed to update mirror for ${repo}:`, err)
      // Continue with possibly stale mirror rather than failing
    }
    return mirrorPath
  }

  // Create parent dirs
  const parentDir = join(REPOS_DIR, repo.split('/')[0])
  mkdirSync(parentDir, { recursive: true })

  // Clone bare
  console.log(`[webhook-workspace] Creating bare mirror for ${repo}...`)
  await execFileAsync('gh', ['repo', 'clone', repo, mirrorPath, '--', '--bare'], {
    timeout: GIT_TIMEOUT_MS,
  })

  return mirrorPath
}

/**
 * Create an isolated workspace for a webhook session.
 * Clones from the bare mirror and checks out the target branch.
 *
 * @param sessionId - Unique session ID, used as the workspace directory name.
 * @param repo      - GitHub repo in `owner/name` format.
 * @param cloneUrl  - HTTPS clone URL for git remote (must be a github.com URL).
 * @param branch    - Branch name to check out.
 * @param headSha   - Exact commit SHA to pin the workspace to.
 * @returns The absolute path to the created workspace directory.
 */
export async function createWorkspace(
  sessionId: string,
  repo: string,
  cloneUrl: string,
  branch: string,
  headSha: string,
): Promise<string> {
  const mirrorPath = await ensureBareMirror(repo)

  const workspacePath = join(WORKSPACES_DIR, sessionId)
  mkdirSync(workspacePath, { recursive: true })

  let setupComplete = false
  try {
    // Clone from local mirror
    console.log(`[webhook-workspace] Cloning workspace for session ${sessionId}...`)
    await execFileAsync('git', ['clone', mirrorPath, workspacePath], {
      timeout: GIT_TIMEOUT_MS,
    })

    // Validate cloneUrl — only allow HTTPS GitHub URLs
    if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(cloneUrl)) {
      throw new Error(`Invalid clone URL: ${cloneUrl}`)
    }

    // Validate branch name — only safe characters
    if (!/^[a-zA-Z0-9/_.-]+$/.test(branch)) {
      throw new Error(`Invalid branch name: ${branch}`)
    }

    // Set up remote to point to the real repo for pushes
    await execFileAsync('git', ['remote', 'set-url', 'origin', cloneUrl], {
      cwd: workspacePath,
      timeout: GIT_TIMEOUT_MS,
    })

    // Validate headSha — must be a 40-char hex string (full SHA-1)
    if (!/^[0-9a-f]{40}$/i.test(headSha)) {
      throw new Error(`Invalid head SHA: ${headSha}`)
    }

    // Fetch the specific branch
    await execFileAsync(
      'git',
      ['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
      { cwd: workspacePath, timeout: GIT_TIMEOUT_MS, env: GIT_AUTH_ENV },
    )

    // Check out the branch (not detached HEAD) so Claude can commit and push fixes
    console.log(`[webhook-workspace] Checking out branch ${branch}`)
    await execFileAsync('git', ['checkout', '-B', branch, `origin/${branch}`], {
      cwd: workspacePath,
      timeout: GIT_TIMEOUT_MS,
    })

    // Pin to the exact commit that triggered the failure, so Claude works on the
    // right code even if the branch has advanced since the webhook was sent.
    console.log(`[webhook-workspace] Pinning to commit ${headSha.slice(0, 7)}`)
    await execFileAsync('git', ['reset', '--hard', headSha], {
      cwd: workspacePath,
      timeout: GIT_TIMEOUT_MS,
    })

    // Set git author for webhook commits
    await execFileAsync('git', ['config', 'user.name', 'Claude (Webhook)'], {
      cwd: workspacePath,
      timeout: GIT_TIMEOUT_MS,
    })
    await execFileAsync('git', ['config', 'user.email', 'claude-webhook@codekin.local'], {
      cwd: workspacePath,
      timeout: GIT_TIMEOUT_MS,
    })

    // Ensure gh credential helper is available for push
    await execFileAsync('git', ['config', 'credential.helper', '!/usr/bin/gh auth git-credential'], {
      cwd: workspacePath,
      timeout: GIT_TIMEOUT_MS,
    })

    setupComplete = true
    return workspacePath
  } finally {
    // Clean up partial workspace on setup failure to prevent disk exhaustion
    // and exposure of cloned source code from private repositories.
    if (!setupComplete && existsSync(workspacePath)) {
      try {
        rmSync(workspacePath, { recursive: true, force: true })
        console.warn(`[webhook-workspace] Cleaned up partial workspace for session ${sessionId} after setup failure`)
      } catch (cleanupErr) {
        console.warn(`[webhook-workspace] Failed to clean up partial workspace ${workspacePath}:`, cleanupErr)
      }
    }
  }
}

/**
 * Remove a workspace directory when a session closes.
 *
 * @param sessionId - Session ID whose workspace should be cleaned up.
 */
export function cleanupWorkspace(sessionId: string): void {
  const workspacePath = join(WORKSPACES_DIR, sessionId)
  if (existsSync(workspacePath)) {
    try {
      rmSync(workspacePath, { recursive: true, force: true })
      console.log(`[webhook-workspace] Cleaned up workspace for session ${sessionId}`)
    } catch (err) {
      console.warn(`[webhook-workspace] Failed to clean up workspace ${sessionId}:`, err)
    }
  }
}
