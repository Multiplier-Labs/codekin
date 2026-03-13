# Codekin REST API Reference

All endpoints are served by the WebSocket server (default port 32352) and proxied through nginx at `/cc`.

## Authentication

All endpoints (except raw webhook receivers) require a Bearer token in the `Authorization` header:

```
Authorization: Bearer <token>
```

The token is set via the `AUTH_TOKEN` environment variable or `--auth-file` CLI argument. Hook endpoints (`/api/tool-approval`, `/api/hook-decision`, `/api/hook-notify`) also accept session-scoped tokens.

Unauthenticated requests return `401 Unauthorized`.

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

**Request body:** `{ "path": "/home/user/repos" }`
**Response:** `{ "path": "/home/user/repos" }`

### `GET /api/settings/support-provider`

Get the preferred AI provider for background tasks (auto-naming, etc.).

**Response:** `{ "preferred": "auto", "available": ["groq", "openai", "gemini", "anthropic"] }`

### `PUT /api/settings/support-provider`

Set the preferred support provider.

**Request body:** `{ "provider": "groq" }` (one of: `auto`, `groq`, `openai`, `gemini`, `anthropic`)
**Response:** `{ "preferred": "groq" }`

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

### `POST /api/tool-approval`

PreToolUse hook callback — check if a tool should be auto-approved or prompt the UI.

**Request body:** `{ "sessionId": "...", "toolName": "Bash", "toolInput": { "command": "npm test" } }`
**Response:** `{ "allow": true, "always": false }`

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
**Response:** `{ "schedule": Schedule }`

### `PATCH /api/workflows/schedules/:id`

Update a schedule.

**Request body:** `{ "cronExpression": "...", "input": {}, "enabled": false }` (all fields optional)
**Response:** `{ "schedule": Schedule }` or `404`

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

**Request body:** `{ "id": "...", "name": "...", "repoPath": "...", "cronExpression": "...", "enabled": true, "customPrompt": "...", "kind": "...", "model": "..." }`
**Response:** `{ "config": WorkflowConfig }`

### `PATCH /api/workflows/config/repos/:id`

Update a repo workflow configuration.

**Response:** `{ "config": WorkflowConfig }` or `404`

### `DELETE /api/workflows/config/repos/:id`

Remove a repo workflow configuration.

**Response:** `{ "config": WorkflowConfig }`
