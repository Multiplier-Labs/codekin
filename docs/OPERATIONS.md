# Operations Guide

Operational reference for running Codekin in production. Covers the two runtime-protection / resilience subsystems an operator is most likely to need to reason about:

- [WebSocket Rate Limiting](#websocket-rate-limiting) — per-IP connection caps and per-connection message rate limits.
- [Workflow Restart-Resume & Orphan-Session Handling](#workflow-restart-resume--orphan-session-handling) — how the workflow engine recovers in-flight runs across server restarts and handles sessions that disappear mid-run.
- [Hosted Relay](#hosted-relay-appcodekinai) — the control plane, the hosted frontend, and the per-machine connector.

---

## WebSocket Rate Limiting

Codekin's WebSocket server applies two complementary rate limits to keep a single client (or a flood of malformed traffic) from monopolizing the server:

1. A **per-IP connection limit** that caps how many new WebSocket connections an IP can open in a rolling window.
2. A **per-connection message rate limit** that caps how many frames a single open connection can send per second.

This section covers both. The implementations live in [`server/ws-server.ts`](../server/ws-server.ts) (per-IP connection limit) and [`server/ws-rate-limit.ts`](../server/ws-rate-limit.ts) (per-connection message limit). The per-connection message limiter was added in PR [#435](https://github.com/Multiplier-Labs/codekin/pull/435) and hardened against an off-by-one boundary bug in PR [#438](https://github.com/Multiplier-Labs/codekin/pull/438).

### Per-IP Connection Limit

Each new WebSocket handshake is checked against an in-memory per-IP counter **before** any application code runs.

| Knob | Value | Source |
|---|---|---|
| Max connections per IP | `30` | `WS_RATE_MAX_CONNECTIONS` in `server/ws-server.ts` |
| Window length | `60_000` ms (60s) | `WS_RATE_WINDOW_MS` in `server/ws-server.ts` |
| Map cap | `10_000` distinct IPs | `WS_RATE_MAP_MAX_SIZE` in `server/ws-server.ts` |

These are compile-time constants — there are no env-var overrides today. Adjust them by editing `server/ws-server.ts` and rebuilding.

#### Key strategy

The IP key is taken from `req.socket.remoteAddress`, **except** when the server runs behind a trusted proxy. When `TRUST_PROXY=true` is set in the environment, the first entry of the `X-Forwarded-For` header is used instead so that nginx-forwarded clients are bucketed by their real source IP rather than the loopback address.

> **Note**: if you forget to set `TRUST_PROXY=true` behind nginx, every client will key as `127.0.0.1` and the limit will be hit globally rather than per-client. Confirm with `journalctl -u codekin -f` and look for `4029 Too many connections` close codes against `127.0.0.1`.

#### Behavior on overflow

When an IP exceeds the connection cap, the server immediately closes the new connection with:

| Close code | Reason | Meaning |
|---|---|---|
| `4029` | `Too many connections` | The client opened more than `WS_RATE_MAX_CONNECTIONS` connections in the current 60s window |

Existing connections from the same IP are unaffected.

#### Map cap

To prevent unbounded memory growth from a stream of unique IPs (e.g. a port-scan or a botnet flood), the per-IP map is capped at `WS_RATE_MAP_MAX_SIZE = 10_000` entries. Once full, any new IP is rejected outright until expired entries are reaped. A reaper runs every `WS_RATE_WINDOW_MS` and removes entries whose `resetAt` has passed.

### Per-Connection Message Rate Limit

Once a WebSocket is established, every inbound frame is counted against a per-connection limiter. This is the limiter implemented in `server/ws-rate-limit.ts`.

| Knob | Default | Source |
|---|---|---|
| Max messages per window | `60` | First arg to `createMessageRateLimiter()` in `server/ws-server.ts` |
| Window length | `1_000` ms (1s) | Second arg to `createMessageRateLimiter()` in `server/ws-server.ts` |
| Disconnect threshold | `2 × limit` (`120` frames in window) | Hard-coded in `server/ws-rate-limit.ts` |

These are passed positionally at the call site:

```ts
// server/ws-server.ts
const rateLimiter = createMessageRateLimiter(60, 1000)
```

Adjust by editing the call site and rebuilding. There is currently no env-var override.

#### Counter strategy

The counter is incremented for **every observed frame, before any JSON parsing**. This is deliberate — it prevents a flood of malformed (unparseable) frames from bypassing the limit. A regression test in `server/ws-rate-limit.test.ts` covers this case explicitly.

#### Window strategy

The window is a **fixed window**, not a sliding/rolling window. `windowStart` is captured on the first observed frame and the counter resets when the next frame arrives at or past `windowStart + windowMs`. PR [#438](https://github.com/Multiplier-Labs/codekin/pull/438) (commit `11cf610`) changed the rollover comparison from strict `>` to `>=` so that a frame arriving exactly on the boundary correctly starts a new window instead of being charged to the previous one.

#### Behavior on overflow

| Frame number in window | Action |
|---|---|
| 1 – 60 | Allowed. Frame is parsed and dispatched normally. |
| 61 (first overflow) | Frame is dropped. Server sends a single `system_message` to the client: `Rate limit exceeded (60 messages/second). Message dropped.` |
| 62 – 120 | Frame is dropped. No additional warning is sent. |
| 121+ | Frame is dropped **and** the connection is closed with code `4029`, reason `Message rate limit exceeded`. |

The two-stage response — warn first, only disconnect on sustained abuse — gives well-behaved clients a chance to back off without losing their session, while a runaway client (or attack) is still cut off.

### Monitoring in Production

There is no dedicated metrics endpoint for either limiter. Use the server log:

```bash
journalctl -u codekin -f | grep -E '4029|Rate limit'
```

Specifically:

- A burst of `4029 Too many connections` close codes from one IP indicates a noisy (or hostile) client opening more than 30 sessions/minute. Investigate before raising `WS_RATE_MAX_CONNECTIONS`.
- A burst of `4029 Message rate limit exceeded` close codes indicates a single connection sustaining > 120 messages/second. Most legitimate UI traffic is well under 60/sec, so this is almost always a buggy client or an attack — investigate before tuning.
- The per-frame `system_message` warning is sent to the client only, not logged server-side. To observe it from the operator side, attach a WebSocket inspector (browser devtools → Network → WS) to a session and trigger the limit by sending > 60 frames/sec.

### Tuning

Both limits are intentionally generous for normal interactive use:

- 30 connections/IP/minute easily covers tab churn, page reloads, and split-screen workflows.
- 60 messages/second/connection is well above the natural cap of typed input + button clicks.

Raise them only if you have a confirmed legitimate use case (e.g. a scripted client driving Codekin) and you have rate-limit handling on the client side. Raising blindly removes the only protection against a runaway client.

To change values, edit the constants / call-site arguments listed above and rebuild & redeploy.

### Known Limitations

- **Single-instance only.** Both limiters are in-process maps. A multi-instance deployment behind a load balancer would let a client multiply their effective allowance by the number of instances. Use `ip_hash` (or equivalent sticky routing) at the load balancer if you scale out.
- **Fixed (not sliding) window for messages.** A client that sends 60 frames at the very end of one window and another 60 at the very start of the next can momentarily achieve `120 frames` over a sub-second interval without tripping disconnect. The disconnect threshold (`2 × limit` within a single window) catches sustained abuse; this remaining boundary slack is acceptable in practice.
- **No env-var configuration.** Both limiters use hard-coded constants. Operators who need per-environment tuning must fork the call site or wire env-var reads themselves.
- **Message-limit warning is single-shot.** Inside a single overflow window the client only sees one `system_message`. Subsequent dropped frames are silent until the window rolls over, to avoid amplifying the flood the limiter is trying to suppress.

### Related Source

- [`server/ws-rate-limit.ts`](../server/ws-rate-limit.ts) — message-rate limiter implementation (`createMessageRateLimiter`, `observe()`)
- [`server/ws-rate-limit.test.ts`](../server/ws-rate-limit.test.ts) — regression tests (overflow boundary, invalid-JSON flood, window rollover)
- [`server/ws-server.ts`](../server/ws-server.ts) — per-IP connection limit (`checkWsRateLimit`) and message-limiter call site

---

## Workflow Restart-Resume & Orphan-Session Handling

The Codekin workflow engine persists each run to SQLite and executes the four built-in steps (`validate_repo`, `create_session`, `run_prompt`, `save_report` — see [WORKFLOWS.md](./WORKFLOWS.md)) sequentially. Two failure modes used to silently lose work:

1. **Server restart mid-run.** A `running` row was left in place, never reaped. On the next startup the engine ignored it and the report was never produced.
2. **Session-not-found between steps.** When `create_session` succeeded but the session was destroyed (manually or by lifecycle cleanup) before `run_prompt` could reattach, downstream code crashed with a generic `Session X not found` stack trace.

PR [#437](https://github.com/Multiplier-Labs/codekin/pull/437) addresses both. This section is the operator reference.

Related observability change shipped in the same release: PR [#436](https://github.com/Multiplier-Labs/codekin/pull/436) silences the orchestrator's "passive repo" alert for repos that have no enabled workflow schedules — so a quiet repo no longer triggers a misleading recommendation to de-schedule what isn't scheduled.

### Heartbeat Columns

PR #437 adds three additive, nullable columns to the `workflow_runs` table:

| Column | Type | Purpose |
|---|---|---|
| `session_id` | `TEXT` | Codekin session id captured by `create_session`. Lets resume locate a still-alive session even if the server crashed before the step's output row was committed. |
| `last_step_at` | `TEXT` (ISO timestamp) | Heartbeat — updated at the start of every step. Distinguishes a stuck `running` row from a freshly-started one. |
| `current_step_key` | `TEXT` | Key of the step that was most recently marked `running`. Tells the resume scan exactly where the work stopped. |

The migration is performed by `WorkflowEngine.migrateSchema()` in [`server/workflow-engine.ts`](../server/workflow-engine.ts). Each `ALTER TABLE ... ADD COLUMN` is wrapped in try/catch because SQLite has no `ADD COLUMN IF NOT EXISTS` — a re-run on a migrated DB is a no-op (the "duplicate column name" error is the expected idempotent path).

> **Note**: the migration is purely additive and the new columns are nullable. Older runs created before PR #437 will simply have `NULL` in all three columns and will be treated by the resume scan as "no session id recorded — cannot resume". They are marked failed loudly rather than silently skipped (see below).

### Heartbeat Behavior

Inside `executeRun()`, immediately after a step is marked `running`:

```ts
this.db.prepare(
  `UPDATE workflow_runs SET last_step_at = ?, current_step_key = ? WHERE id = ?`
).run(stepStarted, stepDef.key, run.id)
```

So `last_step_at` advances on every step boundary. A run that has been `running` for a long time without `last_step_at` advancing is genuinely stuck inside that step (typically waiting on Claude inside `run_prompt`), as opposed to being "queued behind something else."

The session id is recorded atomically by `create_session` itself, via the context-injected helper:

```ts
// server/workflow-loader.ts, create_session step
ctx.recordSessionId?.(session.id)
```

This means the `workflow_runs.session_id` column is set **before** the `create_session` step's own output row is committed. If the server crashes between `create_session` returning and the rest of the engine bookkeeping, the session id is still recoverable from the run row.

### Resume on Engine Startup

`engine.resumeInterrupted()` is called once at startup from `server/ws-server.ts` immediately after `loadMdWorkflows()`:

```ts
// server/ws-server.ts
const engine = initWorkflowEngine()
loadMdWorkflows(engine, sessions)
engine.resumeInterrupted().catch(err => {
  console.error('[workflow] Failed to resume interrupted runs:', err)
})
```

The scan finds all rows with `status = 'running'` and decides for each one:

| Condition | Action |
|---|---|
| Workflow `kind` is no longer registered | Mark **failed** with reason `Server restarted during execution (workflow kind '<kind>' is no longer registered)` |
| `current_step_key` is `validate_repo` or `create_session` (or null) | Mark **failed** with reason `Server restarted during '<step>' step before session was usable for resume` |
| `current_step_key` is `run_prompt` or `save_report` **and** `session_id` is null | Mark **failed** with reason `Server restarted during '<step>' step but no session id was recorded — cannot resume` |
| `current_step_key` is `run_prompt` or `save_report`, `session_id` is set, **but session resolver reports the session is gone** | Mark **failed** with a typed `SessionGoneError` carrying `runId`, `stepKey`, `sessionId`, `lastSeen` |
| `current_step_key` is `run_prompt` or `save_report` and the session is still alive | **Resume** by re-invoking `executeRun()` with `resumeFromKey: <stepKey>` and `resumed: true` in the handler context |

#### Why only the later steps are resumable

The early steps (`validate_repo`, `create_session`) are intentionally non-resumable. By the time those were running, the workflow had no usable session yet, and re-creating one mid-way would risk spawning duplicate sessions or sending the prompt twice. Failing loudly is the right answer for those — the operator can restart the run from scratch with no risk of doubled side effects.

#### Resume semantics for `run_prompt`

When the resumed step is `run_prompt`, the handler receives `ctx.resumed === true` and **does not re-send the prompt**. It just re-attaches to the session and waits on the result Claude is (still) producing. This avoids forking the conversation if the original prompt was already in flight.

#### "Failing loudly" vs silent skip

Earlier behaviour was to mark interrupted runs as `failed` with a generic message and silently mark remaining steps `skipped`. PR #437 keeps the failure surface but tightens the reasons so reports don't go missing without a trace. Every failure reason now identifies the run id, the step that was running, and (where available) the session id and last-seen heartbeat. Search server logs for `[workflow] resume:` to see the resume scan's per-run decisions.

### Friendly Error When a Session is Gone

A new typed error in [`server/workflow-engine.ts`](../server/workflow-engine.ts):

```ts
export class SessionGoneError extends Error {
  constructor(
    public readonly runId: string,
    public readonly stepKey: string,
    public readonly sessionId: string,
    public readonly lastSeen: string | null,
  ) { ... }
}
```

The message is shaped like:

```
Workflow session is no longer available — run=<runId> step=<stepKey> session=<sessionId> lastSeen=<ISO timestamp or "unknown">
```

`SessionGoneError` is thrown from three call sites in [`server/workflow-loader.ts`](../server/workflow-loader.ts):

1. The pre-flight check at the top of `run_prompt` (before any side effects).
2. `waitForSessionResult()` when the session disappears mid-poll.
3. The resume scan when the session resolver returns `null` for a previously-recorded session id.

For operators this means a "session destroyed" condition no longer surfaces as `Error: Session abc-123 not found` in a stack trace — it surfaces as a single line of structured context that immediately tells you which run and step were affected.

### Inspecting Workflow State

The workflow database lives at `~/.codekin/workflows.db` (mode `0600`). Use the `sqlite3` CLI:

```bash
sqlite3 ~/.codekin/workflows.db
```

#### Find all runs that survived a restart

```sql
SELECT id, kind, status, current_step_key, session_id, last_step_at, error
FROM workflow_runs
WHERE status = 'running'
ORDER BY last_step_at DESC;
```

If this returns rows **after** the engine has finished its startup `resumeInterrupted()` scan, those runs are genuinely in-flight (likely sitting inside `run_prompt`, waiting on Claude). Compare `last_step_at` against `now()` to gauge progress.

#### Find runs that failed during the resume scan

```sql
SELECT id, kind, current_step_key, session_id, last_step_at, error
FROM workflow_runs
WHERE status = 'failed'
  AND error LIKE '%Server restarted%'
ORDER BY completed_at DESC
LIMIT 20;
```

The `error` column carries the typed reason ("kind no longer registered" / "step too early to resume" / "no session id" / `SessionGoneError`). Cross-reference with `journalctl -u codekin -f` around the corresponding timestamp for full context.

#### Find orphan-session failures specifically

```sql
SELECT id, kind, current_step_key, session_id, last_step_at, error
FROM workflow_runs
WHERE error LIKE 'Workflow session is no longer available%'
ORDER BY completed_at DESC
LIMIT 20;
```

Each row is a run that referenced a session id which the session manager could not find. Use `session_id` to grep server logs for the session's lifecycle.

#### Walk the steps of a single run

```sql
SELECT key, status, error, started_at, completed_at
FROM workflow_steps
WHERE run_id = '<run-id>'
ORDER BY rowid;
```

`rowid` order matches the step definition order (`validate_repo` → `create_session` → `run_prompt` → `save_report`). The combination of run-level `current_step_key` and step-level `status` tells you exactly where the run was when it stopped.

### DB Schema Migration Notes

The migration is **additive and idempotent**:

- Three new nullable columns on `workflow_runs`: `session_id`, `last_step_at`, `current_step_key`.
- No new tables, no new indexes, no column drops or renames.
- Each `ALTER TABLE` is wrapped in try/catch and a "duplicate column name" error is treated as the success path on a re-run.
- No backfill is performed. Older rows keep `NULL` in the new columns; the resume scan treats `NULL session_id` as non-resumable and fails the run loudly with a clear reason.

There is no down-migration. Rolling back to a pre-#437 server build is safe — the older code simply ignores the new columns.

### Related Source

- [`server/workflow-engine.ts`](../server/workflow-engine.ts) — `migrateSchema()`, `executeRun()` (heartbeat write), `recordSessionId()`, `resumeInterrupted()`, `failInterrupted()`, `SessionGoneError`, `setSessionResolver()`
- [`server/workflow-loader.ts`](../server/workflow-loader.ts) — `create_session` calls `ctx.recordSessionId(...)`, `run_prompt` pre-flight check + `resumed` handling, `waitForSessionResult` throws `SessionGoneError`, `loadMdWorkflows` wires the session resolver
- [`server/workflow-engine.test.ts`](../server/workflow-engine.test.ts) — restart-resume and orphan-session test coverage
- [`server/ws-server.ts`](../server/ws-server.ts) — the startup site that calls `engine.resumeInterrupted()`

---

## Hosted Relay (app.codekin.ai)

The hosted relay lets a browser reach a developer machine's local Codekin
server. It is two processes plus a static bundle:

| Piece | Where | What it is |
|---|---|---|
| Control plane / hub | the host serving `app.codekin.ai`, port 32360 | `server/dist/relay/relay-server.js` behind nginx |
| Hosted frontend | `/var/www/codekin-app` | `npm run build:hosted` output, static-served |
| Connector | each developer machine | `server/dist/relay/connector-cli.js`, outbound only |

Design and protocol are in
[HOSTED-RELAY-CONTROL-PLANE-SPEC.md](HOSTED-RELAY-CONTROL-PLANE-SPEC.md); the
build order is in
[HOSTED-RELAY-IMPLEMENTATION-PLAN.md](HOSTED-RELAY-IMPLEMENTATION-PLAN.md).

### Control plane configuration

Read from `~/.codekin-relay/env` (or the process environment, which wins).
The server refuses to boot if a required value is missing, so a
misconfiguration fails at start rather than at first login.

| Key | Required | Notes |
|---|---|---|
| `SESSION_SECRET` | yes | ≥ 32 chars; signs session cookies |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | yes | GitHub **OAuth App** credentials |
| `OWNER_GITHUB_LOGIN` | yes | gets the owner role |
| `ALLOWED_GITHUB_LOGINS` | no | comma-separated; others land in `pending` |
| `PUBLIC_URL` | no | default `http://localhost:5173`; must match the OAuth callback host |
| `RELAY_PORT` | no | default 32360, bound to 127.0.0.1 |
| `AUDIT_RETENTION_DAYS` | no | default 90; `0` disables pruning |
| `NODE_ENV=production` | recommended | required for `Secure` session cookies |

The OAuth App's **Authorization callback URL** must be exactly
`<PUBLIC_URL>/api/auth/github/callback`.

### Deploying

```bash
git pull --ff-only
npm run build:hosted && rsync -a --delete dist-hosted/ /var/www/codekin-app/
cd server && npm run build
pm2 restart codekin-relay    # or: pm2 start server/dist/relay/relay-server.js --name codekin-relay
```

`GET /api/health` reports `machinesOnline` and `browserClients`.

### Connecting a machine

```bash
codekin relay login      # device-code pairing; approve at <PUBLIC_URL>/pair
codekin relay connect    # foreground; run under pm2 to keep it up
```

The connector needs two things about the machine's *local* server, and finds
them in the process environment, then `~/.codekin/env`, then
`~/.config/codekin/env`:

- **`AUTH_TOKEN` or `AUTH_TOKEN_FILE`** — the local server's bearer token. The
  connector runs in a user's shell, which does not inherit the environment a
  pm2- or systemd-managed server was started with, so an install whose token
  lives outside `~/.config/codekin/token` must say where. Without it every
  proxied request is refused and the UI reports `local_unauthorized`.
- **`RELAY_LOCAL_ORIGIN`** (or `CORS_ORIGIN`) — a local server running with
  `NODE_ENV=production` only accepts WebSockets whose `Origin` equals its
  `CORS_ORIGIN`. The connector is not a browser, so it must be told which
  origin to present. Without it REST works but session streaming closes with
  4003.

Only one connector may serve a machine at a time; a second one takes the slot
and the first stops rather than fighting for it.

### Limits

Per user: 40 frames/s (burst 120), 4 stream channels, 16 in-flight requests.
Per machine: 200 frames/s (burst 600), 32 channels, 64 in-flight requests.
Bodies are capped at 8 MB. A peer that stops draining its socket past 8 MB of
backlog has its channel closed rather than growing the hub's memory.
