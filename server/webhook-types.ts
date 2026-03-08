// --- Webhook event state machine ---
export type WebhookEventStatus =
  | 'received'
  | 'filtered'
  | 'duplicate'
  | 'processing'
  | 'session_created'
  | 'completed'
  | 'error'

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
}
