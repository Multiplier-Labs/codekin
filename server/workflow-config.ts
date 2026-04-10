/**
 * Workflow configuration persistence.
 *
 * Manages the list of repositories configured for automated code review,
 * stored as JSON at ~/.codekin/workflow-config.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReviewRepoConfig {
  id: string
  name: string
  repoPath: string
  cronExpression: string
  enabled: boolean
  /** Workflow kind to run. Defaults to 'code-review.daily'. */
  kind?: string
  customPrompt?: string
  /** Claude model to use for this workflow (e.g. 'claude-sonnet-4-6'). Omit for system default. */
  model?: string
  /** AI provider to use for this workflow ('claude' or 'opencode'). Defaults to 'claude'. */
  provider?: 'claude' | 'opencode'
}

export interface WorkflowConfig {
  reviewRepos: ReviewRepoConfig[]
}

// ---------------------------------------------------------------------------
// Config file path
// ---------------------------------------------------------------------------

const CONFIG_DIR = join(homedir(), '.codekin')
const CONFIG_PATH = join(CONFIG_DIR, 'workflow-config.json')

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

export function loadWorkflowConfig(): WorkflowConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = readFileSync(CONFIG_PATH, 'utf-8')
      return JSON.parse(raw) as WorkflowConfig
    }
  } catch (err) {
    console.error('[workflow-config] Failed to load config:', err)
  }
  return { reviewRepos: [] }
}

export function saveWorkflowConfig(config: WorkflowConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true })
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 })
}

// ---------------------------------------------------------------------------
// CRUD helpers
// ---------------------------------------------------------------------------

export function addReviewRepo(repo: ReviewRepoConfig): WorkflowConfig {
  const config = loadWorkflowConfig()
  const idx = config.reviewRepos.findIndex(r => r.id === repo.id)
  if (idx >= 0) {
    config.reviewRepos[idx] = repo
  } else {
    config.reviewRepos.push(repo)
  }
  saveWorkflowConfig(config)
  return config
}

export function removeReviewRepo(id: string): WorkflowConfig {
  const config = loadWorkflowConfig()
  config.reviewRepos = config.reviewRepos.filter(r => r.id !== id)
  saveWorkflowConfig(config)
  return config
}

export function updateReviewRepo(id: string, patch: Partial<ReviewRepoConfig>): WorkflowConfig {
  const config = loadWorkflowConfig()
  const idx = config.reviewRepos.findIndex(r => r.id === id)
  if (idx < 0) throw new Error(`Repo not found: ${id}`)
  config.reviewRepos[idx] = { ...config.reviewRepos[idx], ...patch }
  saveWorkflowConfig(config)
  return config
}
