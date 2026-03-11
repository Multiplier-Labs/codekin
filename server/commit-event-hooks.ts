/**
 * Git hook installation manager for commit-review event dispatching.
 *
 * Manages the codekin section inside each repo's post-commit hook.
 * The hook script is inserted between BEGIN/END markers so it can
 * coexist with other hooks and be cleanly removed.
 *
 * Also manages ~/.codekin/hook-config.json which provides the server
 * URL and auth token to the shell hook script.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from 'fs'
import { execFileSync } from 'child_process'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { loadWorkflowConfig } from './workflow-config.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BEGIN_MARKER = '# BEGIN CODEKIN COMMIT HOOK'
const END_MARKER = '# END CODEKIN COMMIT HOOK'

const HOOK_CONFIG_PATH = join(homedir(), '.codekin', 'hook-config.json')

// Resolve the hook script path relative to this file.
// In compiled mode (dist/), the shell script is at ../server/commit-event-hook.sh
// In source mode, it's a sibling file.
import { fileURLToPath } from 'url'
const __ownDir = dirname(fileURLToPath(import.meta.url))
const HOOK_SCRIPT_SOURCE = existsSync(join(__ownDir, 'commit-event-hook.sh'))
  ? join(__ownDir, 'commit-event-hook.sh')
  : join(__ownDir, '..', 'server', 'commit-event-hook.sh')

// ---------------------------------------------------------------------------
// Hook config (auth token + server URL for the shell script)
// ---------------------------------------------------------------------------

export interface HookConfig {
  serverUrl: string
  authToken: string
}

/**
 * Write ~/.codekin/hook-config.json with the server URL and auth token.
 * File permissions are set to 0600 (owner read/write only) since it contains a secret.
 */
export function ensureHookConfig(authToken: string, serverUrl: string): void {
  const dir = dirname(HOOK_CONFIG_PATH)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const config: HookConfig = { serverUrl, authToken }
  writeFileSync(HOOK_CONFIG_PATH, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 })
  console.log(`[commit-hooks] Hook config written to ${HOOK_CONFIG_PATH}`)
}

// ---------------------------------------------------------------------------
// Hook installation
// ---------------------------------------------------------------------------

/**
 * Resolve the hooks directory for a given repo.
 * Respects `core.hooksPath` if configured, otherwise uses `.git/hooks/`.
 */
function getHooksDir(repoPath: string): string {
  try {
    const customPath = execFileSync(
      'git', ['config', '--get', 'core.hooksPath'],
      { cwd: repoPath, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).toString().trim()
    if (customPath) return customPath
  } catch {
    // Not set — use default
  }
  return join(repoPath, '.git', 'hooks')
}

/**
 * Generate the codekin hook section that will be inserted into post-commit.
 * Sources the shared hook script so updates to the script are picked up
 * without reinstalling hooks.
 */
function generateHookSection(): string {
  return [
    BEGIN_MARKER,
    `# Installed by Codekin — do not edit this section manually`,
    `if [ -f "${HOOK_SCRIPT_SOURCE}" ]; then`,
    `  . "${HOOK_SCRIPT_SOURCE}"`,
    `fi`,
    END_MARKER,
  ].join('\n')
}

/**
 * Install the codekin post-commit hook section into a repo.
 * If the hook file already exists, the codekin section is appended (or replaced).
 * If not, a new file is created with a shebang + the section.
 */
export function installCommitHook(repoPath: string): boolean {
  const hooksDir = getHooksDir(repoPath)
  const hookPath = join(hooksDir, 'post-commit')

  if (!existsSync(hooksDir)) {
    mkdirSync(hooksDir, { recursive: true })
  }

  const section = generateHookSection()
  let content: string

  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, 'utf-8')

    // Already installed — replace existing section
    if (existing.includes(BEGIN_MARKER)) {
      const re = new RegExp(`${escapeRegex(BEGIN_MARKER)}[\\s\\S]*?${escapeRegex(END_MARKER)}`)
      content = existing.replace(re, section)
    } else {
      // Append to existing hook
      content = existing.trimEnd() + '\n\n' + section + '\n'
    }
  } else {
    // New file
    content = `#!/bin/sh\n\n${section}\n`
  }

  writeFileSync(hookPath, content, 'utf-8')
  chmodSync(hookPath, 0o755)
  console.log(`[commit-hooks] Installed post-commit hook at ${hookPath}`)
  return true
}

/**
 * Remove the codekin section from a repo's post-commit hook.
 * If the file only contains the codekin section (+ shebang), removes the file entirely.
 */
export function uninstallCommitHook(repoPath: string): boolean {
  const hooksDir = getHooksDir(repoPath)
  const hookPath = join(hooksDir, 'post-commit')

  if (!existsSync(hookPath)) return false

  const existing = readFileSync(hookPath, 'utf-8')
  if (!existing.includes(BEGIN_MARKER)) return false

  const re = new RegExp(`\\n?${escapeRegex(BEGIN_MARKER)}[\\s\\S]*?${escapeRegex(END_MARKER)}\\n?`)
  const cleaned = existing.replace(re, '\n').trim()

  // If only the shebang remains, the hook is effectively empty
  if (!cleaned || cleaned === '#!/bin/sh' || cleaned === '#!/bin/bash') {
    // Remove the now-empty hook file
    unlinkSync(hookPath)
    console.log(`[commit-hooks] Removed empty post-commit hook at ${hookPath}`)
  } else {
    writeFileSync(hookPath, cleaned + '\n', 'utf-8')
    console.log(`[commit-hooks] Removed codekin section from ${hookPath}`)
  }

  return true
}

// ---------------------------------------------------------------------------
// Sync: install/uninstall hooks based on current config
// ---------------------------------------------------------------------------

/**
 * Sync commit hooks with the current workflow config.
 * Installs hooks for enabled commit-review repos, uninstalls for disabled/removed ones.
 */
export function syncCommitHooks(): void {
  const config = loadWorkflowConfig()
  const commitReviewRepos = new Set<string>()

  // Install hooks for enabled commit-review repos
  for (const repo of config.reviewRepos) {
    if (repo.kind === 'commit-review' && repo.enabled) {
      commitReviewRepos.add(repo.repoPath)
      try {
        if (existsSync(join(repo.repoPath, '.git'))) {
          installCommitHook(repo.repoPath)
        }
      } catch (err) {
        console.warn(`[commit-hooks] Failed to install hook for ${repo.repoPath}:`, err)
      }
    }
  }

  // Uninstall hooks for repos that are no longer configured for commit-review
  for (const repo of config.reviewRepos) {
    if (!commitReviewRepos.has(repo.repoPath)) {
      try {
        uninstallCommitHook(repo.repoPath)
      } catch {
        // Silently ignore — hook may not exist
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
