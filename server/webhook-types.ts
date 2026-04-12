// --- Webhook event state machine ---
export type WebhookEventStatus =
  | 'received'
  | 'filtered'
  | 'duplicate'
  | 'processing'
  | 'session_created'
  | 'completed'
  | 'error'
  | 'superseded'

export interface WebhookEvent {
  id: string                    // X-GitHub-Delivery ID
  idempotencyKey: string        // sha256 composite key
  receivedAt: string            // ISO timestamp
  event: string                 // X-GitHub-Event value
  action: string                // payload.action
  repo: string                  // owner/name
  branch: string                // head branch
  workflow: string              // workflow name
  runId: number                 // workflow run ID
  runAttempt: number            // run_attempt for re-runs
  conclusion: string            // success, failure, etc.
  status: WebhookEventStatus
  sessionId?: string            // if a session was created
  error?: string                // if processing failed
  filterReason?: string         // if filtered out, why
  // PR-specific fields (populated when event is pull_request)
  prNumber?: number              // PR number
  prTitle?: string               // PR title
  headSha?: string               // head commit SHA
  baseBranch?: string            // target branch
}

// --- GitHub payload subset (workflow_run) ---
export interface WorkflowRunPayload {
  action: string
  workflow_run: {
    id: number
    name: string
    run_number: number
    run_attempt: number
    head_branch: string
    head_sha: string
    conclusion: string | null
    event: string
    actor: { login: string }
    html_url: string
    check_suite_id: number
    pull_requests: Array<{
      number: number
      head: { ref: string; sha: string }
      base: { ref: string }
    }>
  }
  repository: {
    full_name: string
    name: string
    clone_url: string
  }
}

// --- CI failure context collected from gh CLI ---
export interface FailureContext {
  repo: string                  // owner/repo
  repoName: string              // short name
  branch: string
  headSha: string
  workflowName: string
  runId: number
  runNumber: number
  runAttempt: number
  actor: string
  event: string
  htmlUrl: string
  failedLogs: string            // truncated log output
  annotations: Annotation[]
  jobs: JobInfo[]
  pullRequest?: {
    number: number
    title?: string
  }
  commitMessage?: string
}

export interface Annotation {
  path: string
  startLine: number
  endLine: number
  message: string
  annotationLevel: string       // 'failure' | 'warning' | 'notice'
}

export interface JobInfo {
  id: number
  name: string
  conclusion: string
  steps: Array<{
    name: string
    number: number
    conclusion: string
  }>
}

// --- Dedup entry ---
export interface DedupEntry {
  processedAt: string
  eventId: string
}

// --- Webhook configuration (Phase 1 subset) ---
export interface WebhookConfig {
  enabled: boolean
  maxConcurrentSessions: number
  logLinesToInclude: number
  actorAllowlist: string[]
}

// --- GitHub payload subset (pull_request) ---
export interface PullRequestPayload {
  action: string
  number: number
  before?: string                 // previous head SHA (on synchronize)
  after?: string                  // new head SHA (on synchronize)
  pull_request: {
    number: number
    title: string
    body: string | null
    state: string                 // "open" | "closed"
    draft: boolean
    merged: boolean
    user: { login: string }
    head: {
      ref: string
      sha: string
      repo: { clone_url: string } | null
    }
    base: {
      ref: string
      sha: string
    }
    html_url: string
    changed_files: number
    additions: number
    deletions: number
  }
  repository: {
    full_name: string
    name: string
    clone_url: string
  }
  sender: { login: string }
}

// --- GitHub webhook object (from Hooks API) ---
export interface GitHubWebhook {
  id: number
  active: boolean
  config: { url: string; content_type: string; insecure_ssl?: string }
  events: string[]
  created_at: string
  updated_at: string
}

// --- GitHub webhook delivery (from Deliveries API) ---
export interface GitHubDelivery {
  id: number
  delivered_at: string
  status: string
  status_code: number
  event: string
  action: string | null
}

// --- Integration health check result ---
export interface HealthCheckDetail {
  ok: boolean
  message: string
}

export interface HealthCheckResult {
  overall: 'healthy' | 'degraded' | 'broken' | 'unconfigured'
  checks: {
    ghCli: HealthCheckDetail
    config: HealthCheckDetail & { details?: { enabled: boolean; secretSet: boolean } }
    webhook: HealthCheckDetail & { details?: { id: number; active: boolean; events: string[]; url: string } }
    deliveries: HealthCheckDetail & { details?: { recent: Array<{ id: number; status: string; statusCode: number; deliveredAt: string; event: string }> } }
  }
}

// --- Webhook setup preview ---
export interface SetupPreview {
  action: 'create' | 'update' | 'none'
  existing?: GitHubWebhook
  proposed: { url: string; events: string[]; active: boolean }
  changes?: string[]
}

// --- PR review context collected from gh CLI ---
export interface PullRequestContext {
  repo: string                    // owner/repo
  repoName: string
  prNumber: number
  prTitle: string
  prBody: string
  prUrl: string
  author: string
  headBranch: string
  baseBranch: string
  headSha: string
  baseSha: string
  beforeSha?: string              // previous head SHA (on synchronize)
  action: 'opened' | 'synchronize' | 'reopened' | 'ready_for_review'
  changedFiles: number
  additions: number
  deletions: number
  diff: string                    // fetched via gh, potentially truncated
  fileList: string                // formatted list of changed files
  commitMessages: string          // formatted commit messages
  reviewComments: string          // existing inline review comments
  reviews: string                 // existing review summaries
  existingComment: string | null
  priorCache: import('./webhook-pr-cache.js').PrCacheData | null
}
