# GitHub Webhooks Integration — Specification

**Status**: Phase 1 implemented and in production. Phases 2-4 are roadmap.
**Date**: 2026-02-23
**Author**: Codekin Team

---

## Table of Contents

- [Problem Statement](#problem-statement)
- [Goals](#goals)
- [Non-Goals](#non-goals)
- [Architecture Overview](#architecture-overview)
- [Webhook Events](#webhook-events)
- [Auto-Fix Flow](#auto-fix-flow)
- [API Design](#api-design)
- [Configuration](#configuration)
- [Session Behavior](#session-behavior)
- [Security](#security)
- [UI Integration](#ui-integration)
- [Prompt Engineering](#prompt-engineering)
- [Error Handling & Edge Cases](#error-handling--edge-cases)
- [Observability](#observability)
- [Implementation Phases](#implementation-phases)
- [Open Questions](#open-questions)

---

## Problem Statement

When a GitHub Actions workflow fails (linter, build, tests, etc.), the developer must manually:

1. Notice the failure (email, GitHub notification, or checking the PR)
2. Read the CI logs to understand what failed
3. Open the repo, find the relevant files, and fix the issue
4. Push the fix and wait for CI again

Codekin already manages Claude Code sessions bound to repositories. By receiving GitHub webhook events, it can **automatically detect CI failures, fetch the logs, create a session, and have Claude fix the issue** — closing the feedback loop without human intervention.

---

## Goals

1. **Receive GitHub webhook events** securely via a new HTTP endpoint on the WebSocket server
2. **React to CI/CD failures** by auto-creating Claude sessions that diagnose and fix issues
3. **Fetch failure context** (workflow logs, annotations, changed files) and pass them to Claude
4. **Support multiple modes** — fully autonomous (auto-fix + push), supervised (create session, wait for user), or notify-only
5. **Surface webhook activity in the UI** so users can see incoming events and triggered sessions
6. **Keep it simple** — leverage existing session infrastructure, don't reinvent orchestration

---

## Non-Goals

- Replacing GitHub Actions or acting as a CI runner
- Handling every possible GitHub event type (start with CI failures, expand later)
- Multi-tenant / multi-org support (single-installation, single-org for now)
- Custom workflow definitions or pipelines inside Codekin
- Bidirectional sync (Codekin won't update GitHub check statuses... yet)

---

## Architecture Overview

```
GitHub Actions (workflow fails)
  │
  ▼
GitHub Webhook (POST)
  │
  ▼
┌─────────────────────────────────────────────────┐
│  Codekin — WebSocket Server (port 32352)      │
│                                                   │
│  POST /api/webhooks/github                        │
│    ├── Validate HMAC-SHA256 signature             │
│    ├── Parse event type + action                  │
│    ├── Filter: is this a failure we care about?   │
│    ├── Fetch logs via `gh` CLI                    │
│    └── Create session + send prompt to Claude     │
│                                                   │
│  Existing infrastructure:                         │
│    ├── SessionManager.create()                    │
│    ├── SessionManager.sendInput() (auto-starts)   │
│    └── WebSocket broadcast to UI clients          │
└─────────────────────────────────────────────────┘
  │
  ▼
Claude Code CLI (auto-fixes the issue)
  │
  ▼
git push (if autonomous mode)
```

The webhook handler is a thin layer on top of the existing session manager. It:

1. Receives and validates the webhook
2. Extracts failure context
3. Creates a session (or reuses one for the same branch)
4. Sends Claude a structured prompt with the failure details
5. Lets existing session infrastructure handle the rest

### External Dependencies

The webhook handler depends on the `gh` CLI for log fetching and GitHub API access. This is pragmatic for a single-installation deployment where `gh` is already installed and authenticated.

**Startup health check** (required): On server start, the webhook handler must verify:
1. `gh` is installed and on `PATH` (`which gh`)
2. `gh auth status` succeeds (valid authentication)
3. Practical API access test: `gh api /user` returns 200 (confirms auth works regardless of token type — PAT, OAuth, GitHub App installation token, or `GH_TOKEN` env var)

Scope inspection (e.g. checking for `repo` or `actions:read`) is **not reliable** across all auth methods and should not be used as a hard gate. Instead, if a specific API call fails at runtime with `401`/`403`, log an actionable error (e.g. "Failed to fetch workflow logs — check that the token has `actions:read` permission") and degrade gracefully (create the session with available context).

If the health check fails, webhook processing is disabled with a clear log warning. The server continues running for manual sessions.

**Future (Phase 2+)**: Migrate to direct GitHub REST API calls with a `GITHUB_TOKEN` env var for better containerization and reliability.

---

## Webhook Events

### Phase 1 — CI Failures

| GitHub Event | Action/Filter | Phase 1? | Description |
|---|---|---|---|
| `workflow_run` | `action: completed` + `conclusion: failure` | **Yes** | A workflow run finished and failed |
| `check_run` | `action: completed` + `conclusion: failure` | No (Phase 2) | An individual check (job/step) failed |
| `check_suite` | `action: completed` + `conclusion: failure` | No (Phase 2) | A full check suite failed |

**Phase 1 implements `workflow_run` only.** This fires once per workflow and includes the full context (repo, branch, head SHA, PR associations). `check_run` and `check_suite` are listed for future reference.

### Phase 2 — Expanded Events (Future)

| GitHub Event | Use Case |
|---|---|
| `pull_request` | Auto-review PRs, suggest changes |
| `issues` | Triage new issues, attempt auto-fix for bug reports |
| `push` | Run analysis on new commits |
| `issue_comment` | Respond to comments mentioning `@claude` |
| `pull_request_review` | Address review feedback automatically |

### Event Filtering

Not every failure should trigger a session. Configurable filters:

```yaml
# Filter by workflow name
workflows:
  include: ["lint", "build", "test"]   # only these workflows
  exclude: ["deploy", "release"]       # never these

# Filter by branch
branches:
  include: ["main", "develop", "feature/*"]
  exclude: ["dependabot/*"]

# Filter by repository (for org-wide webhooks)
repos:
  include: ["*"]        # all repos
  exclude: ["archived-repo"]
```

---

## Auto-Fix Flow

### Step-by-Step

```
1. RECEIVE   → GitHub sends workflow_run event (conclusion: failure)
2. VALIDATE  → Verify HMAC signature, check event filters
3. CONTEXT   → Fetch failure details (API traversal chain):
               a. `gh run view <run_id> --log-failed` → failed step logs
               b. `gh api /repos/{owner}/{repo}/actions/runs/{run_id}/jobs`
                  → job/step structure (names, conclusions, step numbers)
               c. Use `check_suite_id` from the `workflow_run` payload:
                  `gh api /repos/{owner}/{repo}/check-suites/{check_suite_id}/check-runs?per_page=100`
                  → list check runs directly tied to this workflow run
                    (no name matching needed; filter for `conclusion: failure`)
                  Paginate with `page` parameter if > 100 check runs.
               d. For each failed check run:
                  `gh api /repos/{owner}/{repo}/check-runs/{check_run_id}/annotations?per_page=50`
                  → file:line annotations; paginate if needed (max 50/page)
                  Degrade gracefully if no annotations exist (some CI tools
                  don't produce them).
               e. Identify the branch, PR (if any), and head commit
4. REPO      → Prepare an isolated per-session workspace:
               a. Ensure a shared bare mirror exists at
                  `~/.codekin/repos/{owner}/{repo}.git`
                  (create via `gh repo clone --bare` if missing)
               b. Clone from the bare mirror into a session-specific
                  directory: `~/.codekin/workspaces/{sessionId}/`
               c. Deterministic checkout:
                  `git fetch origin +refs/heads/{branch}:refs/remotes/origin/{branch}`
                  `git checkout -B {branch} origin/{branch}`
                  This ensures the local branch is reset to match the
                  remote tip, even if a stale local ref exists.
                  For PR events where the branch may be untrusted,
                  prefer detached HEAD: `git checkout --detach {head_sha}`
               d. Workspace is deleted when the session closes
               This guarantees no cross-session interference (index
               locks, branch conflicts, or uncommitted changes).
5. SESSION   → Check concurrent webhook session count:
               - If >= max (default 3) → reject with log warning
               - Create new session
               Phase 2 additions:
               - Reuse existing idle session for same branch
               - Queue event if session active (configurable)
6. PROMPT    → Send Claude a structured prompt with:
               - What failed (workflow name, job, step)
               - Error logs (truncated to relevant portion)
               - File annotations (file:line if available)
               - Branch context and recent commits
               - Instructions based on mode (fix+push, fix+PR, diagnose-only)
7. EXECUTE   → Claude reads files, diagnoses, fixes
8. COMPLETE  → Based on mode:
               - autonomous: Claude commits + pushes, session auto-closes
               - supervised: Session stays open, user notified to review
               - notify-only: Summary posted, no code changes
```

### Operating Modes (Phase 2+; Phase 1 is always `supervised`)

| Mode | Behavior | Use Case |
|---|---|---|
| `autonomous` | Claude fixes + commits + pushes automatically (blocked on protected branches — see below) | Lint fixes, formatting, simple build errors |
| `supervised` | Claude creates the fix but waits for user review | Test failures, logic errors |
| `notify-only` | Claude diagnoses and summarizes, no code changes | Complex failures, awareness |

**Protected branch guard**: Autonomous mode **never** pushes directly to branches listed in `git.protectedBranches` (default: `["main", "master"]`). When a failure occurs on a protected branch, the handler automatically:

1. Creates a fix branch (e.g. `fix/main/lint`) per the `fixBranchPattern` config
2. Pushes the fix to that branch
3. Opens a PR targeting the protected branch (if `createPR` is enabled)
4. Falls back to `supervised` mode if branch creation fails

Mode can be configured globally or per-workflow (Phase 2+):

```json
{
  "defaultMode": "supervised",
  "workflowModes": {
    "lint": "autonomous",
    "build": "supervised",
    "deploy": "notify-only"
  }
}
```

---

## API Design

### Webhook Endpoint

```
POST /api/webhooks/github
```

**Headers** (set by GitHub):
- `X-GitHub-Event`: Event type (`workflow_run`, `check_run`, etc.)
- `X-GitHub-Delivery`: Unique delivery ID (for deduplication)
- `X-Hub-Signature-256`: HMAC-SHA256 of the payload
- `Content-Type`: `application/json`

**Response** (returned immediately; session creation and CI log fetching happen asynchronously):
- `202 Accepted` — Event accepted for async processing (session will be created in background)
- `200 OK` — Event received but filtered out (no action taken)
- `400 Bad Request` — Malformed payload
- `401 Unauthorized` — Invalid or missing signature
- `429 Too Many Requests` — Max concurrent webhook sessions reached

**Response Body** (202 — accepted for processing):
```json
{
  "accepted": true,
  "eventId": "abc-123",
  "status": "processing",
  "sessionId": "uuid-here"
}
```

The `sessionId` is a **pre-allocated UUID** reserved before async processing begins. The session may not be fully initialized yet — clients should listen for `webhook_event` WebSocket messages to know when the session is ready.

**Response Body** (200 — filtered, no action):
```json
{
  "accepted": false,
  "eventId": "abc-123",
  "status": "filtered",
  "filterReason": "workflow 'deploy' is excluded"
}
```

### Webhook Management Endpoints

```
GET  /api/webhooks/events            — List recent webhook events (with status)
GET  /api/webhooks/events/:id        — Get details for a specific event
GET  /api/webhooks/config            — Get current webhook configuration
PUT  /api/webhooks/config            — Update webhook configuration
POST /api/webhooks/test              — Send a test event (for debugging)
```

### Webhook Event Record

Stored in memory (with optional disk persistence):

```typescript
interface WebhookEvent {
  id: string;                          // X-GitHub-Delivery ID
  receivedAt: string;                  // ISO timestamp
  event: string;                       // X-GitHub-Event value
  action: string;                      // payload.action
  repo: string;                        // owner/name
  branch: string;                      // head branch
  workflow: string;                     // workflow name
  runId: number;                       // workflow run ID
  conclusion: string;                  // success, failure, etc.
  status: 'received' | 'filtered' | 'processing' | 'session_created' | 'completed' | 'error';
  sessionId?: string;                  // if a session was created
  error?: string;                      // if processing failed
  filterReason?: string;               // if filtered out, why
}
```

---

## Configuration

### Environment Variables

| Variable | Required | Default | Phase | Description |
|---|---|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | Yes | — | 1 | Shared secret for HMAC signature validation |
| `GITHUB_WEBHOOK_ENABLED` | No | `false` | 1 | Master switch to enable webhook processing |
| `GITHUB_WEBHOOK_MAX_SESSIONS` | No | `3` | 1 | Max concurrent auto-created sessions |
| `GITHUB_WEBHOOK_MODE` | No | `supervised` | 2 | Default operating mode — **Phase 1 is always `supervised`**; this env var is ignored until Phase 2 |
| `GITHUB_WEBHOOK_LOG_LINES` | No | `200` | 1 | Max lines of CI logs to include in prompt |
| `GITHUB_WEBHOOK_ACTOR_ALLOWLIST` | No | `""` (all actors) | 1 | Comma-separated list of GitHub usernames allowed to trigger webhook processing. When non-empty, events from actors not in this list are filtered out with a `200 filtered` response. Comparison is case-insensitive. Overrides the `actorAllowlist` array in the config file. |

### Config File

`~/.codekin/webhook-config.json`:

```json
{
  "enabled": true,
  "defaultMode": "supervised",
  "maxConcurrentSessions": 3,
  "logLinesToInclude": 200,

  "actorAllowlist": ["alice", "bob"],

  "filters": {
    "workflows": { "include": ["*"], "exclude": ["deploy"] },
    "branches": { "include": ["*"], "exclude": ["dependabot/*"] },
    "repos": { "include": ["*"], "exclude": [] }
  },

  "workflowModes": {
    "lint": "autonomous",
    "typecheck": "autonomous",
    "build": "supervised",
    "test": "supervised"
  },

  "session": {
    "autoClose": true,
    "autoCloseDelay": 300,
    "reuseExisting": true,
    "namingPattern": "webhook/{repo}/{branch}/{workflow}"
  },

  "git": {
    "commitPrefix": "fix(ci):",
    "protectedBranches": ["main", "master"],
    "pushToSameBranch": true,
    "createFixBranch": false,
    "createPR": true,
    "fixBranchPattern": "fix/{branch}/{workflow}"
  }
}
```

---

## Session Behavior

### Session Naming

Auto-created sessions follow a naming pattern for easy identification:

```
webhook/codekin/feature-auth/lint
webhook/my-app/main/test
```

Format: `webhook/{repo}/{branch}/{workflow}` where `{repo}` is the short repo name (e.g. `codekin`, not `Multiplier-Labs/codekin`)

### WebhookEvent State Machine

```
received → processing → session_created → completed
    │           │                              ▲
    │           ├─→ error ─────────────────────┘ (retry or manual)
    │           │
    └─→ filtered (terminal)
    └─→ duplicate (terminal)
```

| Transition | Trigger |
|---|---|
| `received` → `filtered` | Event doesn't match filters (workflow, branch, repo) |
| `received` → `duplicate` | Idempotency key or delivery ID already processed |
| `received` → `processing` | Event passes filters, worker picks it up |
| `processing` → `session_created` | Session successfully created and prompt sent |
| `processing` → `error` | Log fetch failed, session creation failed, or max sessions reached |
| `session_created` → `completed` | Claude session finishes (fix pushed, review ready, or diagnosis posted) |
| `error` → `processing` | Manual retry via API (Phase 2) |

### Session Lifecycle

```
┌─────────┐     ┌───────────┐     ┌──────────┐     ┌──────────┐
│ Created  │ ──▶ │  Running   │ ──▶ │ Waiting  │ ──▶ │  Closed  │
│          │     │ (Claude    │     │ (review) │     │          │
│          │     │  fixing)   │     │          │     │          │
└─────────┘     └───────────┘     └──────────┘     └──────────┘
                      │                                    ▲
                      │ (autonomous mode)                  │
                      └────────────────────────────────────┘
```

| Transition | Trigger |
|---|---|
| `Created` → `Running` | Claude process starts and receives the prompt |
| `Running` → `Waiting` | (supervised/notify-only) Claude finishes; awaiting user review |
| `Running` → `Closed` | (autonomous) Claude commits + pushes successfully |
| `Waiting` → `Closed` | User approves/dismisses, or auto-close timer expires (Phase 2) |
| `Running` → `Closed` | Claude encounters unrecoverable error; event marked `error` |

- **Created**: Session created, workspace cloned to the failing branch
- **Running**: Claude is actively diagnosing/fixing
- **Waiting**: (supervised mode) Fix applied, waiting for user review
- **Closed**: Fix pushed, session dismissed, or error occurred. Workspace cleaned up.

### Session Reuse

When a new failure arrives for a branch that already has an active webhook session:

- **Session idle** → Reuse: send new failure context as follow-up input
- **Session active (Claude running)** → Queue: process after current run finishes
- **Session in review** → Notify: add context to session, alert user

### Resource Limits

- Maximum concurrent webhook sessions: configurable (default 3)
- Queued events expire after 30 minutes
- Sessions auto-close after configurable delay post-completion

---

## Security

### Webhook Signature Validation

Every incoming webhook **must** include a valid `X-Hub-Signature-256` header:

```typescript
import crypto from 'crypto';

function verifyWebhookSignature(payload: Buffer, signature: string, secret: string): boolean {
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  // timingSafeEqual throws if lengths differ — guard against that
  if (signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
```

**Important — raw body handling**: The HMAC must be computed against the exact raw payload bytes, not a re-serialized JSON object. The webhook route **must** use `express.raw({ type: 'application/json' })` (or a `verify` callback on `express.json()`) to preserve the raw `Buffer`. Standard `express.json()` parses into an object and re-stringifying it may alter whitespace, causing signature verification to fail.

Requests with missing or invalid signatures are rejected with `401`.

### Rate Limiting

### Phase 1 — Simple Rate Limiting

Phase 1 uses a straightforward two-stage model with no queuing:

| Stage | Limit | Enforcement | Rejection |
|---|---|---|---|
| **HTTP intake** | 30 requests/min per repo | Express rate-limit middleware (keyed on `repo` from payload); runs *before* signature validation to protect against DoS | `429 Too Many Requests` |
| **Session cap** | Max 3 concurrent webhook sessions (configurable via `GITHUB_WEBHOOK_MAX_SESSIONS`) | Checked after validation, before session creation | `429` with `status: "max_sessions_reached"` |

Events that arrive when the session cap is full are **rejected** (not queued). The caller (GitHub) will retry per its own schedule.

### Phase 2+ — Full Pipeline

Phase 2 adds an event queue and worker pool for higher throughput:

```
HTTP intake → Event queue → Worker pool → Session creation
```

| Stage | Limit | Enforcement | Rejection |
|---|---|---|---|
| **HTTP intake** | 30 requests/min per repo | Express rate-limit middleware | `429 Too Many Requests` |
| **Event queue** | Max 50 pending events | In-memory bounded queue | `429` — event dropped with log warning |
| **Worker pool** | 5 concurrent processing workers | Semaphore around log-fetch + session-create | Event stays queued until a worker is free |
| **Session cap** | Max 3 concurrent webhook sessions (configurable) | Checked before session creation | Event fails with `max_sessions_reached` |

### Scope Restrictions

- Webhook sessions run with the same permissions as manual sessions
- `autonomous` mode auto-approves only: `Bash(git:*)`, `Read`, `Write`, `Edit`, `Glob`, `Grep`
- No dangerous tools auto-approved (no arbitrary Bash, no network access beyond git)
- Claude's `--permission-mode` and `--allowedTools` flags enforce boundaries

### Management Endpoint Authentication

All non-webhook API routes (`/api/webhooks/events`, `/api/webhooks/config`, `/api/webhooks/test`) require authentication:

- **Bearer token** (MUST): Requests MUST include `Authorization: Bearer <token>` using the same `API_AUTH_TOKEN` env var that protects other Codekin API routes. Requests without a valid token MUST be rejected with `401`.
- **CSRF** (SHOULD): If management endpoints are accessed from a browser with cookie auth, responses SHOULD include `X-Content-Type-Options: nosniff` and the server SHOULD validate `Origin`/`Referer` headers or use CSRF tokens.
- **Network exposure** (SHOULD): The webhook endpoint (`POST /api/webhooks/github`) is publicly reachable (GitHub must reach it), but management endpoints SHOULD be restricted to internal networks or localhost. Consider `WEBHOOK_MGMT_BIND` env var to bind management routes to `127.0.0.1` separately.
- **IP allowlisting** (MAY): For the webhook endpoint, GitHub publishes its [webhook IP ranges](https://api.github.com/meta). An optional `GITHUB_WEBHOOK_ALLOWED_IPS` env var MAY restrict webhook delivery acceptance to these ranges.

### Secret Management

- `GITHUB_WEBHOOK_SECRET` must be set as an environment variable (not in config file)
- The secret is never logged or exposed via API
- Management endpoints require `Authorization: Bearer <API_AUTH_TOKEN>` (see above)

---

## UI Integration

### Webhook Events Panel

A new sidebar section or tab showing recent webhook events:

```
┌─────────────────────────────────────┐
│ ⚡ Webhook Events                    │
├─────────────────────────────────────┤
│ ● lint failed — codekin/main     │
│   → Session created (fixing...)     │
│   2 min ago                         │
│                                     │
│ ○ test failed — my-app/feature-x    │
│   → Filtered (branch excluded)      │
│   5 min ago                         │
│                                     │
│ ✓ lint failed — my-app/main         │
│   → Fixed and pushed                │
│   12 min ago                        │
└─────────────────────────────────────┘
```

### Session Indicators

Webhook-created sessions are visually distinct:

- **Tab badge**: Small webhook icon on the session tab
- **Session header**: Shows "Triggered by: lint workflow failure on main" context
- **Auto-close countdown**: If auto-close is enabled, shows remaining time

### Notifications

When a webhook creates a session, connected clients receive:

```typescript
{
  type: 'webhook_event',
  event: 'workflow_run',
  repo: 'codekin',
  branch: 'main',
  workflow: 'lint',
  conclusion: 'failure',
  status: 'session_created',   // matches WebhookEvent.status field
  sessionId: 'uuid'
}
```

The UI can show a toast notification and optionally auto-switch to the new session.

Note: The `status` field in WebSocket messages uses the same values as the `WebhookEvent.status` state machine. The `received` state is internal (exists only between HTTP accept and worker pickup) and is never sent to clients.

---

## Prompt Engineering

The initial prompt sent to Claude is critical. It should be structured, concise, and actionable.

### Template

    A GitHub Actions workflow has failed and needs to be fixed.

    ## Failure Details
    - **Repository**: {owner}/{repo}
    - **Branch**: {branch}
    - **Workflow**: {workflow_name} (run #{run_number})
    - **Failed job**: {job_name}
    - **Failed step**: {step_name}
    - **Trigger**: {event} by {actor}
    - **Commit**: {head_sha} — "{commit_message}"
    {#if pull_request}
    - **Pull Request**: #{pr_number} — "{pr_title}"
    {/if}

    ## Error Logs
    ```
    {failed_step_logs}
    ```

    {#if annotations}
    ## Annotations
    {#each annotations}
    - {path}:{line} — {message}
    {/each}
    {/if}

    ## Instructions
    {#if mode == "autonomous"}  {{-- Phase 2+ only --}}
    Fix the issue, commit with the prefix "{commit_prefix}", and push to the `{branch}` branch.
    Only fix what the CI failure requires — do not refactor or improve unrelated code.
    If this is a protected branch, create a fix branch and open a PR instead.
    {/if}
    {#if mode == "supervised"}  {{-- Phase 1 default --}}
    Diagnose and fix the issue. Apply the changes but DO NOT commit or push.
    Explain what you found and what you changed so the developer can review.
    {/if}
    {#if mode == "notify-only"}  {{-- Phase 2+ only --}}
    Diagnose the failure and explain what's wrong and how to fix it.
    DO NOT modify any files.
    {/if}

### Log Truncation

CI logs can be very long. The prompt includes at most `logLinesToInclude` lines, focused on:

1. The **failed step's** output (not the entire run)
2. Last N lines, prioritizing error output
3. Annotations (file:line references) extracted separately for precision

---

## Error Handling & Edge Cases

| Scenario | Handling |
|---|---|
| Webhook secret not configured | Reject all webhooks with `500`, log warning on startup |
| Repo not cloned locally | Auto-clone via `gh repo clone`, then proceed |
| Branch doesn't exist locally | `git fetch && git checkout {branch}` |
| Repo already checked out by another session | Not applicable — each session gets its own workspace cloned from a shared bare mirror |
| Max concurrent webhook sessions reached | Reject with `429` and log warning (Phase 1); queue for later (Phase 2) |
| Duplicate delivery (same delivery ID or idempotency key) | Deduplicate via composite key (see Deduplication below), return `200` with `status: "duplicate"` |
| Claude fails to fix the issue | Keep session open, mark event as `error`, notify user |
| Workflow succeeds on re-run (before Claude finishes) | Optionally cancel the session (configurable) |
| Multiple failures on same branch in quick succession | Batch into single session, send combined context |
| `gh` CLI not authenticated | Log error, skip log fetching, create session with basic context |
| Network error fetching logs | Create session anyway with available context, note the gap |

### Deduplication

GitHub retries webhook deliveries on non-2xx responses and timeouts. Simple in-memory dedup on `X-GitHub-Delivery` is lost on server restart. The deduplication strategy uses a **composite idempotency key**:

```
idempotencyKey = sha256(owner + repo + event + runId + action + conclusion + run_attempt)
```

Components:
- `owner/repo` — repository identity
- `event` — GitHub event type (e.g. `workflow_run`)
- `runId` — workflow run ID
- `action` + `conclusion` — event action and conclusion
- `run_attempt` — distinguishes re-runs of the same workflow run

Storage:
- **Primary**: In-memory `Map<string, { processedAt: string, eventId: string }>` with 1-hour TTL (based on `processedAt` timestamp; entries older than 1 hour are evicted on each lookup/flush)
- **Persistence**: Flushed to `~/.codekin/webhook-dedup.json` every 60 seconds and on shutdown; loaded on startup. Uses **atomic writes**: write to a temp file in the same directory, then `rename()` to the target path. File created with mode `0600` (owner read/write only) to prevent metadata leakage.
- **Bounded**: Max 1000 entries; oldest evicted when full
- **Lookup**: Check both `X-GitHub-Delivery` ID (primary key if present) and composite key — either match means duplicate
- **Null fields**: If any component of the composite key is missing/null, substitute an empty string. The `X-GitHub-Delivery` header should always be present but if absent, fall back to composite key only

---

## Observability

### Logging

All webhook activity logged with structured fields:

```
[webhook] Received workflow_run (failure) for codekin/main — lint
[webhook] Signature verified, event accepted (delivery: abc-123)
[webhook] Fetching logs for run #456...
[webhook] Creating session: webhook/codekin/main/lint
[webhook] Session uuid-789 started, Claude processing...
[webhook] Session uuid-789 completed — fix pushed to main
```

### Metrics (Future)

- `webhook.events.received` — total events received (by event type)
- `webhook.events.processed` — events that triggered sessions
- `webhook.events.filtered` — events filtered out
- `webhook.sessions.created` — auto-created sessions
- `webhook.fixes.pushed` — successful autonomous fixes
- `webhook.fixes.failed` — fix attempts that failed

### Event History

Last 100 webhook events stored in memory, accessible via:

- `GET /api/webhooks/events` — API endpoint
- UI webhook events panel
- Persisted to `~/.codekin/webhook-events.json` on shutdown

---

## Implementation Phases

### Phase 1 — Core Webhook Handler [Implemented]

**Scope**: Receive webhooks, validate, create sessions with failure context.

- [x] Add `POST /api/webhooks/github` endpoint to `ws-server.ts`
- [x] Implement HMAC-SHA256 signature validation (with raw body middleware)
- [x] Parse `workflow_run` events with `conclusion: failure`
- [x] Fetch failed run logs via `gh run view --log-failed`
- [x] Fetch annotations via jobs API → check-runs → annotations traversal chain
- [x] Create session with structured prompt
- [x] Add `GITHUB_WEBHOOK_SECRET` and `GITHUB_WEBHOOK_ENABLED` env vars
- [x] `gh` CLI startup health check (installed, authenticated, `gh api /user` succeeds)
- [x] Composite idempotency key deduplication with disk persistence
- [x] Rate limiting: HTTP intake (30 req/min per repo) + session cap check (no queuing in Phase 1)
- [x] Per-session workspace isolation (bare mirror + session-specific clone)
- [x] Bearer token auth on management endpoints (`/api/webhooks/events`, `/config`)
- [x] Robot icon on webhook-created session tabs
- [x] `source` field on Session types (server + client)
- [x] Basic event logging with WebhookEvent state machine transitions

**Deliverable**: Webhooks trigger Claude sessions that diagnose and fix CI failures. Webhook sessions are visually distinct in the UI.

### Phase 2 — Configuration & Modes [Planned — Not Yet Implemented]

**Scope**: Make behavior configurable, add operating modes.

- [ ] Implement webhook config file (`~/.codekin/webhook-config.json`)
- [ ] Add event filtering (by workflow, branch, repo)
- [ ] Implement operating modes (autonomous, supervised, notify-only)
- [ ] Per-workflow mode overrides
- [ ] Session reuse for same branch
- [ ] `GET/PUT /api/webhooks/config` endpoints
- [ ] Resource limits (max concurrent sessions, queue)

**Deliverable**: Configurable, production-ready webhook processing.

### Phase 3 — UI Integration [Planned — Not Yet Implemented]

**Scope**: Surface webhook activity in the frontend.

- [ ] Add `webhook_event` WebSocket message type
- [ ] Webhook events panel in sidebar
- [ ] Visual distinction for webhook-created sessions
- [ ] Toast notifications for new webhook events
- [ ] Auto-switch to webhook session option
- [ ] Webhook configuration UI (settings panel)

**Deliverable**: Full visibility into webhook activity from the browser.

### Phase 4 — Expanded Events [Planned — Not Yet Implemented]

**Scope**: Handle more GitHub event types.

- [ ] `pull_request` events — auto-review, suggest changes
- [ ] `issues` events — triage, attempt auto-fix for bugs
- [ ] `issue_comment` / `pull_request_review` — respond to mentions
- [ ] `push` events — run analysis on new commits
- [ ] Outbound: update check run status on GitHub when Claude completes

**Deliverable**: Codekin as a full GitHub-integrated AI assistant.

---

## Known Limitations (Phase 1)

- **No automatic session cleanup** — Webhook-created sessions accumulate and must be manually deleted. Auto-close with configurable delay is planned for Phase 2.
- **No session reuse** — If two failures arrive for the same branch, two separate sessions are created. Session reuse is planned for Phase 2.
- **No event queuing** — When max concurrent sessions is reached, events are rejected (not queued). Queuing is planned for Phase 2.
- **Workspace disk usage** — Each webhook session clones from a bare mirror into its own workspace directory. Workspaces are cleaned up on session close, but abnormal termination may leave orphans. A periodic cleanup job is planned for Phase 2.

---

## Open Questions

1. **GitHub App vs. personal webhook?** — A GitHub App would allow installation across repos with fine-grained permissions. Personal webhooks are simpler but per-repo. Start with personal webhooks, migrate to App later?

2. **Log size limits** — Some CI runs produce megabytes of logs. What's the right truncation strategy? Last N lines of the failed step? Regex-based extraction of error messages?

3. ~~**Concurrent fix conflicts**~~ — **Resolved**: `git.protectedBranches` config prevents autonomous pushes to `main`/`master`. Autonomous mode on protected branches creates a fix branch + PR instead.

4. **Feedback loop** — If Claude's fix itself fails CI, should it retry? How many times? Should it escalate to `supervised` mode after N failures?

5. **Cost control** — Each webhook-triggered session consumes API tokens. Should there be a daily budget or token cap for webhook-triggered sessions?

6. **PR comments** — Instead of (or in addition to) pushing fixes, should Claude post its diagnosis as a PR comment? This would integrate with existing code review workflows.
