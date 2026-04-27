# Workflow Restart-Resume & Orphan-Session Handling

The Codekin workflow engine persists each run to SQLite and executes the four built-in steps (`validate_repo`, `create_session`, `run_prompt`, `save_report` — see [WORKFLOWS.md](../WORKFLOWS.md)) sequentially. Two failure modes used to silently lose work:

1. **Server restart mid-run.** A `running` row was left in place, never reaped. On the next startup the engine ignored it and the report was never produced.
2. **Session-not-found between steps.** When `create_session` succeeded but the session was destroyed (manually or by lifecycle cleanup) before `run_prompt` could reattach, downstream code crashed with a generic `Session X not found` stack trace.

PR [#437](https://github.com/Multiplier-Labs/codekin/pull/437) addresses both. This document is the operator reference.

Related observability change shipped in the same release: PR [#436](https://github.com/Multiplier-Labs/codekin/pull/436) silences the orchestrator's "passive repo" alert for repos that have no enabled workflow schedules — so a quiet repo no longer triggers a misleading recommendation to de-schedule what isn't scheduled.

---

## Heartbeat Columns

PR #437 adds three additive, nullable columns to the `workflow_runs` table:

| Column | Type | Purpose |
|---|---|---|
| `session_id` | `TEXT` | Codekin session id captured by `create_session`. Lets resume locate a still-alive session even if the server crashed before the step's output row was committed. |
| `last_step_at` | `TEXT` (ISO timestamp) | Heartbeat — updated at the start of every step. Distinguishes a stuck `running` row from a freshly-started one. |
| `current_step_key` | `TEXT` | Key of the step that was most recently marked `running`. Tells the resume scan exactly where the work stopped. |

The migration is performed by `WorkflowEngine.migrateSchema()` in [`server/workflow-engine.ts`](../../server/workflow-engine.ts). Each `ALTER TABLE ... ADD COLUMN` is wrapped in try/catch because SQLite has no `ADD COLUMN IF NOT EXISTS` — a re-run on a migrated DB is a no-op (the "duplicate column name" error is the expected idempotent path).

> **Note**: the migration is purely additive and the new columns are nullable. Older runs created before PR #437 will simply have `NULL` in all three columns and will be treated by the resume scan as "no session id recorded — cannot resume". They are marked failed loudly rather than silently skipped (see below).

---

## Heartbeat Behavior

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

---

## Resume on Engine Startup

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

### Why only the later steps are resumable

The early steps (`validate_repo`, `create_session`) are intentionally non-resumable. By the time those were running, the workflow had no usable session yet, and re-creating one mid-way would risk spawning duplicate sessions or sending the prompt twice. Failing loudly is the right answer for those — the operator can restart the run from scratch with no risk of doubled side effects.

### Resume semantics for `run_prompt`

When the resumed step is `run_prompt`, the handler receives `ctx.resumed === true` and **does not re-send the prompt**. It just re-attaches to the session and waits on the result Claude is (still) producing. This avoids forking the conversation if the original prompt was already in flight.

### "Failing loudly" vs silent skip

Earlier behaviour was to mark interrupted runs as `failed` with a generic message and silently mark remaining steps `skipped`. PR #437 keeps the failure surface but tightens the reasons so reports don't go missing without a trace. Every failure reason now identifies the run id, the step that was running, and (where available) the session id and last-seen heartbeat. Search server logs for `[workflow] resume:` to see the resume scan's per-run decisions.

---

## Friendly Error When a Session is Gone

A new typed error in [`server/workflow-engine.ts`](../../server/workflow-engine.ts):

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

`SessionGoneError` is thrown from three call sites in [`server/workflow-loader.ts`](../../server/workflow-loader.ts):

1. The pre-flight check at the top of `run_prompt` (before any side effects).
2. `waitForSessionResult()` when the session disappears mid-poll.
3. The resume scan when the session resolver returns `null` for a previously-recorded session id.

For operators this means a "session destroyed" condition no longer surfaces as `Error: Session abc-123 not found` in a stack trace — it surfaces as a single line of structured context that immediately tells you which run and step were affected.

---

## Inspecting Workflow State

The workflow database lives at `~/.codekin/workflows.db` (mode `0600`). Use the `sqlite3` CLI:

```bash
sqlite3 ~/.codekin/workflows.db
```

### Find all runs that survived a restart

```sql
SELECT id, kind, status, current_step_key, session_id, last_step_at, error
FROM workflow_runs
WHERE status = 'running'
ORDER BY last_step_at DESC;
```

If this returns rows **after** the engine has finished its startup `resumeInterrupted()` scan, those runs are genuinely in-flight (likely sitting inside `run_prompt`, waiting on Claude). Compare `last_step_at` against `now()` to gauge progress.

### Find runs that failed during the resume scan

```sql
SELECT id, kind, current_step_key, session_id, last_step_at, error
FROM workflow_runs
WHERE status = 'failed'
  AND error LIKE '%Server restarted%'
ORDER BY completed_at DESC
LIMIT 20;
```

The `error` column carries the typed reason ("kind no longer registered" / "step too early to resume" / "no session id" / `SessionGoneError`). Cross-reference with `journalctl -u codekin -f` around the corresponding timestamp for full context.

### Find orphan-session failures specifically

```sql
SELECT id, kind, current_step_key, session_id, last_step_at, error
FROM workflow_runs
WHERE error LIKE 'Workflow session is no longer available%'
ORDER BY completed_at DESC
LIMIT 20;
```

Each row is a run that referenced a session id which the session manager could not find. Use `session_id` to grep server logs for the session's lifecycle.

### Walk the steps of a single run

```sql
SELECT key, status, error, started_at, completed_at
FROM workflow_steps
WHERE run_id = '<run-id>'
ORDER BY rowid;
```

`rowid` order matches the step definition order (`validate_repo` → `create_session` → `run_prompt` → `save_report`). The combination of run-level `current_step_key` and step-level `status` tells you exactly where the run was when it stopped.

---

## DB Schema Migration Notes

The migration is **additive and idempotent**:

- Three new nullable columns on `workflow_runs`: `session_id`, `last_step_at`, `current_step_key`.
- No new tables, no new indexes, no column drops or renames.
- Each `ALTER TABLE` is wrapped in try/catch and a "duplicate column name" error is treated as the success path on a re-run.
- No backfill is performed. Older rows keep `NULL` in the new columns; the resume scan treats `NULL session_id` as non-resumable and fails the run loudly with a clear reason.

There is no down-migration. Rolling back to a pre-#437 server build is safe — the older code simply ignores the new columns.

---

## Related Source

- [`server/workflow-engine.ts`](../../server/workflow-engine.ts) — `migrateSchema()`, `executeRun()` (heartbeat write), `recordSessionId()`, `resumeInterrupted()`, `failInterrupted()`, `SessionGoneError`, `setSessionResolver()`
- [`server/workflow-loader.ts`](../../server/workflow-loader.ts) — `create_session` calls `ctx.recordSessionId(...)`, `run_prompt` pre-flight check + `resumed` handling, `waitForSessionResult` throws `SessionGoneError`, `loadMdWorkflows` wires the session resolver
- [`server/workflow-engine.test.ts`](../../server/workflow-engine.test.ts) — restart-resume and orphan-session test coverage
- [`server/ws-server.ts`](../../server/ws-server.ts) — the startup site that calls `engine.resumeInterrupted()`
