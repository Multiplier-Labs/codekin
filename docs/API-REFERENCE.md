# Codekin REST API Reference

All endpoints are served by the WebSocket server (default port 32352) and proxied through nginx at `/cc`.

## Authentication

All endpoints (except raw webhook receivers) require a Bearer token in the `Authorization` header:

```
Authorization: Bearer <token>
```

The token is set via the `AUTH_TOKEN` environment variable or `--auth-file` CLI argument. Hook endpoints (`/api/hook-decision`, `/api/hook-notify`) also accept session-scoped tokens.

Unauthenticated requests return `401 Unauthorized`.

---

## WebSocket Server Hardening

The WebSocket endpoint at `/cc-ws` enforces several transport-level checks before any application message is processed. These are implemented in `server/ws-origin-check.ts`, `server/ws-rate-limit.ts`, and inline in `server/ws-server.ts`.

### Origin validation (`server/ws-origin-check.ts`)

Every incoming WS handshake is checked against the configured frontend origin to mitigate cross-site WebSocket hijacking.

- **Production** (`NODE_ENV=production`): the request is rejected unless the `Origin` header is present and exactly equal to `CORS_ORIGIN`. Browsers always send `Origin` on WebSocket handshakes, so a missing header in production indicates a non-browser client and is also rejected.
- **Development**: a missing `Origin` is allowed (CLI tools, local scripts), but a present-but-mismatched `Origin` is still rejected.

Rejected handshakes are closed with WebSocket code `4003` ("Origin not allowed").

**Configuration:**

| Env var | Default | Notes |
|---|---|---|
| `CORS_ORIGIN` | `http://localhost:5173` | Production startup logs an error and refuses to default if `CORS_ORIGIN` is unset or contains `localhost`. Set it to the deployed frontend origin (e.g. `https://codekin.example.com`). |

### Per-IP connection rate limit (`server/ws-server.ts`)

Connection establishment is rate-limited per client IP, before authentication, to bound resource use under handshake floods. Limits are currently compile-time constants in `server/ws-server.ts`:

| Constant | Value | Meaning |
|---|---|---|
| `WS_RATE_WINDOW_MS` | `60_000` | Rolling window (1 minute) used for per-IP connection counting. |
| `WS_RATE_MAX_CONNECTIONS` | `30` | Maximum new WebSocket connections per IP per window. |
| `WS_RATE_MAP_MAX_SIZE` | `10_000` | Maximum tracked IPs; further new IPs are rejected to prevent unbounded memory growth. |
| `WS_AUTH_TIMEOUT_MS` | `5_000` | Time an unauthenticated connection is held open waiting for an `auth` message before being closed. |

When `TRUST_PROXY` is enabled, the first entry of the `X-Forwarded-For` header is used as the client IP; otherwise `req.socket.remoteAddress` is used. Connections that exceed the per-IP cap are closed with code `4029` ("Too many connections"); auth-timeouts close with `4001` ("Auth timeout").

### Per-connection message rate limit (`server/ws-rate-limit.ts`)

Each authenticated WebSocket connection runs a `createMessageRateLimiter(limit, windowMs)` that increments on **every** observed frame, before JSON parsing. This prevents a flood of malformed frames from bypassing the limit.

Behaviour on overflow:

- The first frame in a window that exceeds `limit` triggers a single `system_message` warning to the client; subsequent dropped frames in the same window are silently discarded.
- Sustained traffic past `2 × limit` causes the server to close the connection with code `4029` ("Message rate limit exceeded").

Defaults are passed at the call site in `server/ws-server.ts`:

| Parameter | Value | Meaning |
|---|---|---|
| `limit` | `60` | Maximum messages per window per connection. |
| `windowMs` | `1000` | Window size in milliseconds (so 60 messages/second). |

These values are not currently env-var configurable; adjust the call to `createMessageRateLimiter(...)` in `ws-server.ts` if you need different thresholds.

---

## Models

Endpoints that accept a `model` field (e.g. session creation via WebSocket, workflow config, orchestrator children) accept the following Claude model identifiers:

| Identifier | Label |
|---|---|
| `claude-opus-5` | Opus 5 |
| `claude-sonnet-5` | Sonnet 5 |
| `claude-opus-4-8` | Opus 4.8 |
| `claude-fable-5` | Fable 5 |
| `claude-opus-4-7` | Opus 4.7 |
| `claude-opus-4-6` | Opus 4.6 |
| `claude-sonnet-4-6` | Sonnet 4.6 |
| `claude-haiku-4-5-20251001` | Haiku 4.5 |

When `model` is omitted, the server default is used.

This table is the **static fallback** list (`FALLBACK_MODELS` in `server/anthropic-models.ts`, mirrored by `CLAUDE_MODELS` in `src/types.ts`), used until dynamic discovery completes or when discovery fails. The live set is whatever `GET /api/claude/models` returns, so newly released models can appear without a code change.

### `GET /api/claude/models`

Return the discovered Claude model list. Results are cached, so a cache hit is cheap. Falls back to the static table above when discovery has not completed or has failed.

**Response:** `{ "models": [{ "id": "claude-opus-5", "label": "Opus 5" }, ...] }`

### `POST /api/claude/models/refresh`

Force model rediscovery, bypassing the cache TTL.

Deliberately `POST`-only and never called automatically: with CLI alias probing this spawns one `claude` process per candidate ID, costing roughly $0.04 per live model. Intended for manual invocation when a newly released model has not appeared yet.

**Rate-limited.** A completed refresh starts a 5-minute cooldown; calls during it return `429` with a `Retry-After` header rather than probing again. The cooldown is global, not per-token, because the cost is. Requests arriving while a probe is already in flight are *not* rejected — they await the same probe, so they cost nothing extra.

**Response:** `{ "models": [{ "id": "...", "label": "..." }, ...] }`

**429 response:** `{ "error": "Model refresh is rate-limited; retry in 90s", "retryAfterSeconds": 90 }`

### `GET /api/codex/models`

Return the model list reported by the Codex app-server's `model/list` method. Cached for 10 minutes. Returns an empty `models` array when the Codex CLI is unavailable or not authenticated.

**Response:** `{ "models": [{ "id": "gpt-5.5", "name": "...", "description": "...", "isDefault": true }, ...] }`

### `GET /api/opencode/models`

Return the models configured on the running OpenCode server, plus the per-provider default model IDs.

**Query params:** `workingDir` (optional, defaults to the user's home directory)

`workingDir` is resolved via `realpath` and then **bounds-checked**: it must equal — or be a descendant of — the user's home directory or the configured `REPOS_ROOT`. This mirrors the boundary enforced by `/api/browse-dirs` and `/api/sessions/create`. A path that cannot be resolved returns `400`; a path outside the allowed roots returns `403`.

**Response:** `{ "models": [{ "id": "...", "name": "...", "providerID": "...", "providerName": "..." }, ...], "defaults": { "<providerID>": "<modelID>" } }`

### `GET /api/opencode/commands`

Return the slash commands, MCP prompts, and skills exposed by the running OpenCode server for the given directory. Backs OpenCode inline slash-command autocomplete.

**Query params:** `workingDir` (optional, defaults to the user's home directory) — resolved and bounds-checked exactly as for `/api/opencode/models`.

**Response:** `{ "commands": [{ "name": "...", "description": "...", "agent": "...", "model": "...", "source": "command" | "mcp" | "skill", "template": "..." }, ...] }`

---

## Auth & Health

### `POST /auth-verify`

Verify whether a token is valid. Does not require auth itself.

**Request body:** `{ "token": "..." }` (or token in Authorization header)
**Response:** `{ "valid": true }` or `{ "valid": false }`

### `GET /api/health`

Server health check.

**Response:**
```json
{
  "status": "ok",
  "claudeAvailable": true,
  "claudeVersion": "1.0.0",
  "apiKeySet": true,
  "claudeSessions": 2,
  "totalSessions": 5
}
```

---

## Sessions

### `GET /api/sessions/list`

List all active sessions.

**Response:** `{ "sessions": Session[] }`

### `POST /api/sessions/create`

Create a new session and auto-start Claude.

**Request body:** `{ "name": "...", "workingDir": "/path/to/repo" }`
**Response:** `{ "sessionId": "...", "session": Session }`

### `PATCH /api/sessions/:id/rename`

Rename a session.

**Request body:** `{ "name": "new name" }`
**Response:** `{ "success": true, "name": "new name" }`

### `DELETE /api/sessions/:id`

Delete a session and kill any running Claude process.

**Response:** `{ "success": true }` or `404`

---

## Session Archive

### `GET /api/sessions/archived`

List archived sessions (metadata only).

**Query params:** `workingDir` (optional) — filter by working directory
**Response:** `{ "sessions": ArchivedSession[] }`

### `GET /api/sessions/archived/:id`

Fetch a single archived session with full chat history.

**Response:** `ArchivedSession` or `404`

### `DELETE /api/sessions/archived/:id`

Permanently delete an archived session.

**Response:** `{ "success": true }` or `404`

---

## Settings

### `GET /api/settings/retention`

Get the session retention period.

**Response:** `{ "days": 30 }`

### `PUT /api/settings/retention`

Set the session retention period.

**Request body:** `{ "days": 30 }` (must be >= 1)
**Response:** `{ "days": 30 }`

### `GET /api/settings/repos-path`

Get the configured repos discovery path (empty string = server default).

**Response:** `{ "path": "/home/user/repos" }`

### `PUT /api/settings/repos-path`

Set the repos discovery path. Empty string resets to server default.

The supplied path is expanded (`~` → home), canonicalized via `realpath`, and then **bounds-checked**: the resolved path must equal — or be a descendant of — the user's home directory or the configured `REPOS_ROOT`. This mirrors the boundary enforced by `/api/browse-dirs` and `/api/sessions/create` and blocks traversal (`../../etc`), absolute paths outside the allowed roots (e.g. `/etc`), and symlinks whose real target escapes the allowed roots.

**Request body:** `{ "path": "/home/user/repos" }`
**Response:** `{ "path": "/home/user/repos" }`, or `400` with `{ "error": "..." }` when:
- `path` is not a string — `"path must be a string"`
- the path does not exist or is not a directory — `"Path does not exist or is not a directory"`
- the path could not be canonicalized — `"Path could not be resolved"`
- the canonicalized path is outside the allowed roots — `"Path is outside allowed directories (must be under home or repos root)"`

### `GET /api/settings/worktree-prefix`

Get the worktree directory prefix.

**Response:** `{ "prefix": "wt" }`

### `PUT /api/settings/worktree-prefix`

Set the worktree directory prefix.

**Request body:** `{ "prefix": "wt" }`
**Response:** `{ "prefix": "wt" }`

### `GET /api/settings/queue-messages`

Get the message queueing setting.

**Response:** `{ "enabled": false }`

### `PUT /api/settings/queue-messages`

Enable or disable message queueing.

**Request body:** `{ "enabled": true }`
**Response:** `{ "enabled": true }`

### `GET /api/settings/agent-name`

Get the orchestrator agent display name.

**Response:** `{ "name": "Agent Joe" }`

### `PUT /api/settings/agent-name`

Set the orchestrator agent display name.

**Request body:** `{ "name": "Agent Joe" }`
**Response:** `{ "name": "Agent Joe" }`

---

## Directory Browsing

### `GET /api/browse-dirs`

Browse directories on the server filesystem (for folder picker UI).

**Query params:** `path` (optional) — directory to list; defaults to home directory
**Response:** `{ "dirs": [{ "name": "repos", "path": "/home/user/repos" }] }`

---

## Approvals

### `GET /api/approvals`

Get auto-approval rules for a repo.

**Query params:** `path` (required) — repo working directory
**Response:** `{ "approvals": Approval[] }`

### `GET /api/approvals/global`

Get global auto-approval rules.

**Response:** `{ "globalApprovals": Approval[] }`

### `DELETE /api/approvals`

Remove one or more approval rules.

**Query params:** `path` (required) — repo working directory
**Request body:** Single: `{ "tool": "...", "command": "...", "pattern": "..." }` or bulk: `{ "items": [...] }`
**Response:** `{ "success": true, "removed": 1 }`

---

## Hook Endpoints

These are called by Claude CLI hooks (PreToolUse / PermissionRequest) running inside session processes. They accept either the master Bearer token or a session-scoped token.

### `POST /api/hook-decision`

PermissionRequest hook callback — route permission decisions through the UI.

**Request body:** `{ "sessionId": "...", "toolName": "Bash", "toolInput": { "command": "..." } }`
**Response:** `{ "allow": true }`

### `POST /api/hook-notify`

Surface hook denial notifications in the UI.

**Request body:** `{ "sessionId": "...", "notificationType": "denial", "message": "...", "toolName": "...", "toolInput": {} }`
**Response:** `{ "ok": true }`

### `POST /api/auth/validate`

Validate a session token.

**Request body:** `{ "sessionId": "..." }`
**Response:** `{ "valid": true }` or `{ "valid": false, "error": "..." }`

---

## File Upload & Repos

### `POST /api/upload`

Upload a file (images or markdown, max 20MB).

**Content-Type:** `multipart/form-data`
**Form field:** `file`
**Response:** `{ "success": true, "path": "/tmp/uploads/..." }`

### `GET /api/repos`

List available repositories grouped by owner.

**Response:**
```json
{
  "groups": [{ "owner": "user", "repos": [...] }],
  "globalSkills": [...],
  "globalModules": [...],
  "reposPath": "/home/user/repos",
  "ghMissing": false
}
```

### `POST /api/clone`

Clone a GitHub repository.

**Request body:** `{ "owner": "org", "name": "repo" }`
**Response:** `{ "success": true, "path": "/home/user/repos/repo" }`

---

## Documentation Browser

### `GET /api/docs`

List markdown files in a repo.

**Query params:** `repo` (required) — repo path
**Response:** `{ "files": [{ "path": "README.md", "pinned": false }] }`

### `GET /api/docs/file`

Read a single markdown file.

**Query params:** `repo` (required), `file` (required) — file path relative to repo
**Response:** `{ "path": "README.md", "content": "# ..." }` or `404`

---

## Webhooks

### `GET /api/webhooks/events`

List recent webhook events.

**Response:** `{ "events": WebhookEvent[] }`

### `GET /api/webhooks/events/:id`

Get a single webhook event.

**Response:** `{ "event": WebhookEvent }` or `404`

### `GET /api/webhooks/config`

Get webhook configuration.

**Response:** `{ "config": { "enabled": true, "maxConcurrentSessions": 3, "logLinesToInclude": 200 } }`

### `POST /api/webhooks/github`

Raw GitHub webhook receiver. **No Bearer token** — uses HMAC signature verification via `x-hub-signature-256` header.

### `POST /api/webhooks/stepflow`

Raw Stepflow webhook receiver. **No Bearer token** — uses signature verification via `x-webhook-signature` header.

---

## Stepflow

### `GET /api/stepflow/events`

List recent stepflow events.

**Response:** `{ "events": StepflowEvent[] }`

### `GET /api/stepflow/events/:id`

Get a single stepflow event.

**Response:** `{ "event": StepflowEvent }` or `404`

---

## Workflows

All workflow routes are mounted at the `/api/workflows/` prefix.

### `POST /api/workflows/commit-event`

Notify the workflow engine of a new commit (called by git post-commit hook).

**Request body:** `{ "repoPath": "...", "branch": "main", "commitHash": "abc123", "commitMessage": "...", "author": "..." }`
**Response:** `{ "accepted": true, ... }`

### `GET /api/workflows/kinds`

List available workflow kinds.

**Query params:** `repoPath` (optional) — filter by repo
**Response:** `{ "kinds": WorkflowKind[] }`

### `GET /api/workflows/runs`

List workflow runs.

**Query params:** `kind`, `status` (`queued`, `running`, `succeeded`, `failed`, `canceled`), `limit`, `offset`
**Response:** `{ "runs": Run[] }`

### `GET /api/workflows/runs/:runId`

Get a single workflow run.

**Response:** `{ "run": Run }` or `404`

### `POST /api/workflows/runs`

Trigger a new workflow run.

**Request body:** `{ "kind": "code-review", "input": {} }`
**Response:** `{ "run": Run }`

### `POST /api/workflows/runs/:runId/cancel`

Cancel a running workflow.

**Response:** `{ "success": true }` or `404`

### `GET /api/workflows/schedules`

List all workflow schedules.

**Response:** `{ "schedules": Schedule[] }`

### `POST /api/workflows/schedules`

Create a new schedule.

**Request body:** `{ "id": "...", "kind": "code-review", "cronExpression": "0 4 * * *", "input": {}, "enabled": true }`
**Response:** `{ "schedule": Schedule }`, or `400` with `{ "error": "..." }` when required fields are missing or `cronExpression` is not a valid 5-field cron.

### `PATCH /api/workflows/schedules/:id`

Update a schedule.

**Request body:** `{ "cronExpression": "...", "input": {}, "enabled": false }` (all fields optional)
**Response:** `{ "schedule": Schedule }`, `400` with `{ "error": "Invalid cron expression" }` when a provided `cronExpression` fails validation, or `404`.

### `DELETE /api/workflows/schedules/:id`

Delete a schedule.

**Response:** `{ "success": true }` or `404`

### `POST /api/workflows/schedules/:id/trigger`

Manually trigger a scheduled workflow.

**Response:** `{ "run": Run }` or `404`

### `GET /api/workflows/config`

Get workflow engine configuration.

**Response:** `{ "config": WorkflowConfig }`

### `POST /api/workflows/config/repos`

Add a repo workflow configuration.

`repoPath` is resolved via `realpath` and must sit under the configured `REPOS_ROOT` — otherwise the request is rejected with `400`.

**Request body:** `{ "id": "...", "name": "...", "repoPath": "...", "cronExpression": "...", "enabled": true, "customPrompt": "...", "kind": "...", "model": "claude-opus-4-8" }` (see [Models](#models) for accepted identifiers)
**Response:** `{ "config": WorkflowConfig, "webhookSetup"?: WebhookSetupResult }`, or `400` with `{ "error": "..." }` when required fields are missing, `provider` is invalid, or `repoPath` is not an existing directory under the configured repos root.

### `PATCH /api/workflows/config/repos/:id`

Update a repo workflow configuration.

**Request body:** Partial `ReviewRepoConfig`. When `repoPath` is supplied, it must resolve to a directory under `REPOS_ROOT`.
**Response:** `{ "config": WorkflowConfig }`, `400` with `{ "error": "Invalid repoPath: ..." }` for an out-of-root `repoPath`, or `404`.

### `DELETE /api/workflows/config/repos/:id`

Remove a repo workflow configuration.

**Response:** `{ "config": WorkflowConfig }`

---

## Loops

Loops 2.0 — durable, event-sourced outcome loops (see [LOOPS.md](./LOOPS.md)
and [LOOPS-REWRITE-SPEC.md](./LOOPS-REWRITE-SPEC.md)). All routes are mounted
at the `/api/loops/` prefix and require the master Bearer token.

### `GET /api/loops/recipes`

List recipes visible to a repo (built-ins plus `{repo}/.codekin/loops/*.md`
overrides). Query: `repoPath` (optional).

**Response:** `{ "recipes": LoopRecipeInfo[] }`

### `GET /api/loops/branches?repoPath=<path>`

Local branches of a cloned repo plus the detected default — the wizard's
base-branch picker.

**Response:** `{ "branches": string[], "defaultBranch": string | null }`

### `POST /api/loops/recipes/validate`

Validate recipe markdown without saving it.

**Request:** `{ "content": string }`
**Response:** `{ "valid": true, "recipe": LoopRecipe }` or `{ "valid": false, "error": string }`

### `POST /api/loops/runs/preflight`

Resolve the exact effective run configuration (frozen recipe, resolved
provider, default branch, outcome) without starting anything.

**Request:** `{ "recipeId": string, "repo": string, "branch"?: string, "baseBranch"?: string, "goal"?: string, "overrides"?: { mode?, planRequired?, budgets?: { turns?, costUsd?, wallTimeMinutes?, noProgressAttempts? } } }`

Overrides are applied to the recipe before it freezes — the run records the
modified recipe under a recomputed content hash.

**Response:** `{ "effective": { recipe, repo, branch, baseBranch, goal, provider, model } }`

### `POST /api/loops/runs`

Start a run. `branch` defaults to `loop/<recipeId>-<timestamp>`; `goal`
defaults to the recipe's outcome prompt.

**Request:** same shape as preflight.
**Response:** `{ "run": LoopRun }`

### `GET /api/loops/runs`

List runs. Query: `state`, `repo`, `active=1`, `limit`.

**Response:** `{ "runs": LoopRun[] }`

### `GET /api/loops/runs/:id`

One run plus its stages, evaluations, the completion scorecard (every
criterion in the frozen recipe with its latest status and evidence),
interventions, artifact metadata, and the current event-sequence cursor.

**Response:** `{ "run": LoopRunDetail }`

### `GET /api/loops/runs/:id/events?after=<sequence>`

The append-only event log — the source of truth clients reconcile against
after a WS reconnect. Events carry `{ runId, sequence, type, at, actor,
stageId?, attemptId?, payload }`.

**Response:** `{ "events": LoopEvent[], "lastSequence": number }`

### `GET /api/loops/runs/:id/artifacts/:artifactId`

An artifact body (evaluator output, review text) as `text/plain`, with
`X-Artifact-Kind` / `X-Artifact-Label` headers.

### `POST /api/loops/runs/:id/pause` · `/resume` · `/cancel`

Pause after the current safe boundary / resume a paused run in its surviving
worktree / stop now (worktree kept). `409` when the run is not in an eligible
state.

### `POST /api/loops/runs/:id/steer`

Queue an operator instruction, delivered to the maker at the next safe
boundary. With `revisePlan`, the maker is asked to revise its plan first.

**Request:** `{ "instruction": string, "revisePlan"?: boolean }`

### `POST /api/loops/runs/:id/fork`

Fork a run into a new one starting from its current worktree state
(uncommitted work included). `409` when no recoverable worktree exists.

**Response:** `{ "run": LoopRun }`

### `GET /api/loops/lessons?recipeId=&status=`

Reflection suggestions (`suggested` / `approved` / `rejected`).

### `POST /api/loops/lessons/:lessonId/approve` · `/reject`

Resolve a suggested lesson; approved lessons join future runs' prompts.

### `GET /api/loops/recipes/:id/stats`

Run outcomes grouped by frozen recipe content hash — A/B comparison across
recipe versions.

**Response:** `{ "recipeId": string, "versions": [{ recipeHash, runs, succeeded, failed, canceled, avgTurns, avgCostUsd, firstRunAt, lastRunAt }] }`

### `POST /api/loops/runs/:id/interventions/:interventionId/resolve`

Resolve a pending intervention. `choice` must be one of the intervention's
offered options; `note` becomes guidance to the maker where applicable.

**Request:** `{ "choice": string, "note"?: string }`

---

## Orchestrator (Agent Joe)

All orchestrator routes are mounted at the `/api/orchestrator/` prefix.

### Status & Lifecycle

#### `GET /api/orchestrator/status`

Get orchestrator session status and summary stats.

**Response:** `{ "status": "active" | "idle" | "restarting", "sessionId": "...", ... }`

#### `POST /api/orchestrator/start`

Ensure the orchestrator session is running. Starts it if not already active.

**Response:** `{ "sessionId": "...", "status": "active" }`

### Reports

#### `GET /api/orchestrator/reports`

List available audit reports. Exactly one of `repo` or `since` must be provided.

When `repo` is supplied, it is resolved via `realpath` and must sit under the configured `REPOS_ROOT`; otherwise the request is rejected with `400`.

**Query params:** `repo` (path under `REPOS_ROOT`) **or** `since` (YYYY-MM-DD date; lists reports across managed repos newer than that date)
**Response:** `{ "reports": ReportMeta[] }`, or `400` with `{ "error": "..." }` when neither query param is provided or when `repo` is not under the configured repos root.

#### `GET /api/orchestrator/reports/read`

Read the contents of a specific report file. The resolved path must sit under `REPOS_ROOT` and contain `/.codekin/reports/`, or under the Codekin data directory's `reports/` subfolder — otherwise the request returns `404`.

**Query params:** `path` (required) — absolute report file path
**Response:** `{ "report": ReportContent }` where `ReportContent` includes `filePath`, `category`, `date`, `repoPath`, `size`, `mtime`, and `content`. `400` when `path` is missing; `404` when the resolved path is outside the allowed roots or the file cannot be read.

### Child Sessions

#### `GET /api/orchestrator/children`

List child sessions spawned by the orchestrator.

**Response:** `{ "children": ChildSession[] }`

#### `POST /api/orchestrator/children`

Spawn a new child session for a task. `repo` is resolved via `realpath` and must sit under `REPOS_ROOT`. `branchName` must match `^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$`.

Because each spawn allocates a real Claude subprocess, this endpoint is additionally **rate-limited per client IP**: at most **20 spawn requests per 5-minute sliding window per IP**. The limiter is keyed on `req.ip` (which honours `X-Forwarded-For` when the server is configured with `TRUST_PROXY`) and runs *before* auth, so even unauthenticated floods are capped. It is applied on top of the global 300-requests-per-minute API limiter.

**Request body:** `{ "repo": "...", "task": "...", "branchName": "...", "useWorktree"?: boolean, "completionPolicy"?: "pr" | "merge" | "commit-only", "deployAfter"?: boolean, "model"?: "claude-opus-4-8", "allowedTools"?: string[] }` (see [Models](#models) for accepted `model` identifiers)
**Response:** `{ "child": ChildSession }`, `400` with `{ "error": "..." }` when required fields are missing, `branchName` / `allowedTools` fail validation, or `repo` is not an existing directory under the configured repos root, `429` with `{ "error": "Too Many Requests", "retryAfter": 300 }` when the per-IP spawn cap is exceeded (`retryAfter` is in seconds), or `503` when the child session cannot be spawned.

#### `GET /api/orchestrator/children/:id`

Get details for a specific child session.

**Response:** `{ "child": ChildSession }` or `404`

### Session Management

#### `GET /api/orchestrator/sessions`

List all sessions visible to the orchestrator.

**Response:** `{ "sessions": Session[] }`

#### `GET /api/orchestrator/sessions/pending-prompts`

Get sessions that have pending approval prompts.

**Response:** `{ "sessions": [{ "sessionId": "...", "prompts": Prompt[] }] }`

#### `POST /api/orchestrator/sessions/:id/respond`

Respond to a pending prompt in a session.

**Request body:** `{ "requestId"?: "...", "value": "..." }`
**Response:** `{ "ok": true }`, `400` when `value` is missing, `404` when the session does not exist, or `409` when there is no pending prompt to respond to.

#### `DELETE /api/orchestrator/sessions/cleanup`

Delete all automated sessions (sources: `workflow`, `webhook`, `stepflow`, `agent`).

**Response:** `{ "deleted": number }` — count of sessions deleted.

#### `DELETE /api/orchestrator/sessions/:id`

Delete a specific orchestrator-managed session.

**Response:** `{ "deleted": true }` or `404`

### Memory

#### `GET /api/orchestrator/memory`

Query the orchestrator's SQLite memory store (supports full-text search).

**Query params:** `q` (optional — FTS query), `type` (optional), `scope` (optional), `limit` (optional)
**Response:** `{ "items": MemoryItem[] }`

#### `POST /api/orchestrator/memory`

Create or update a memory item.

**Request body:** `{ "memory_type": "...", "title": "...", "content": "...", "scope": "...", "tags": [...] }`
**Response:** `{ "item": MemoryItem }`

#### `DELETE /api/orchestrator/memory/:id`

Delete a memory item.

**Response:** `{ "success": true }` or `404`

#### `POST /api/orchestrator/memory/extract`

Extract memory candidates from an interaction.

**Request body:** `{ "userMessage": "...", "assistantResponse": "...", "repo": "..." }`
**Response:** `{ "candidates": MemoryCandidate[] }`

#### `POST /api/orchestrator/memory/age`

Run the memory aging/decay cycle (expire TTLs, compact journals, decay confidence).

**Response:** `{ "expired": number, "compacted": number, "decayed": number }`

### Trust System

#### `GET /api/orchestrator/trust`

List all trust records.

**Response:** `{ "records": TrustRecord[] }`

#### `GET /api/orchestrator/trust/level`

Compute trust level for a specific action signature.

**Query params:** `action`, `category`, `severity`, `repo` (optional)
**Response:** `{ "level": "ask" | "notify_do" | "silent", "approvalCount": number }`

#### `POST /api/orchestrator/trust/approve`

Record a user approval for an action.

**Request body:** `{ "action": "...", "category": "...", "severity": "...", "repo": "..." }`
**Response:** `{ "record": TrustRecord }`

#### `POST /api/orchestrator/trust/reject`

Record a user rejection for an action (resets trust to ASK).

**Request body:** `{ "action": "...", "category": "...", "severity": "...", "repo": "..." }`
**Response:** `{ "record": TrustRecord }`

#### `POST /api/orchestrator/trust/pin`

Pin an action to a specific trust level (user override).

**Request body:** `{ "action": "...", "category": "...", "level": "ask" | "notify_do" | "silent" }`
**Response:** `{ "record": TrustRecord }`

#### `POST /api/orchestrator/trust/reset`

Reset all learned trust records back to ASK.

**Response:** `{ "success": true, "cleared": number }`

### Notifications

#### `GET /api/orchestrator/notifications`

Get pending orchestrator notifications.

**Response:** `{ "notifications": Notification[] }`

#### `POST /api/orchestrator/notifications/mark-delivered`

Mark notifications as delivered.

**Request body:** `{ "ids": ["..."] }`
**Response:** `{ "success": true }`

### Dashboard

#### `GET /api/orchestrator/dashboard`

Get summary statistics for the orchestrator dashboard.

**Response:**
```json
{
  "stats": {
    "managedRepos": 5,
    "pendingNotifications": 3,
    "activeChildren": 2,
    "totalChildren": 8,
    "trustRecords": 12,
    "autoApproved": 6,
    "memoryItems": 42
  }
}
```

### Findings & Learning

#### `POST /api/orchestrator/findings/outcome`

Record the outcome of an audit finding (implemented, skipped, false positive, etc.).

**Request body:** `{ "action": "...", "category": "...", "severity": "...", "outcome": "implemented" | "skipped" | "false_positive", "repo": "..." }`
**Response:** `{ "success": true }`

#### `GET /api/orchestrator/findings/recommend`

Get triage recommendations based on historical finding outcomes.

**Query params:** `category`, `severity`
**Response:** `{ "recommendation": "implement" | "skip" | "review", "confidence": 0.85, "stats": {...} }`

### Skills & User Model

#### `GET /api/orchestrator/skills`

Get the user skill profile.

**Response:** `{ "skills": { "typescript": { "level": "advanced", ... }, ... } }`

#### `POST /api/orchestrator/skills`

Record a skill signal observation.

**Request body:** `{ "domain": "typescript", "signal": "Used advanced generics", "level": "advanced" }`
**Response:** `{ "skill": SkillLevel }`

### Decisions

#### `POST /api/orchestrator/decisions`

Record a decision with rationale and expected outcome.

**Request body:** `{ "title": "...", "rationale": "...", "expectedOutcome": "...", "scope": "..." }`
**Response:** `{ "decision": DecisionRecord }`

#### `POST /api/orchestrator/decisions/:id/assess`

Assess the actual outcome of a past decision.

**Request body:** `{ "actualOutcome": "...", "success": true }`
**Response:** `{ "decision": DecisionRecord }`

#### `GET /api/orchestrator/decisions/pending`

Get decisions older than 7 days that haven't been assessed yet.

**Response:** `{ "decisions": DecisionRecord[] }`
