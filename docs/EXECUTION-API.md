# Execution API

The execution API lets your own applications use the coding agents you have already signed in to in Codekin for **bounded model jobs**. Examples are classifying an email, extracting fields as JSON, or drafting a short reply. The jobs run through the agent CLI's own login (for Codex, ChatGPT sign-in), so an application needs no provider API key of its own.

Each job is one isolated model turn that runs nothing. It is not a coding session: there is no repository, worktree, shell, file access, MCP server or web access. Your skills, instruction files and machine details are kept out of the job's context: the model sees your instructions and input, plus Codex's own built-in system and tool instructions.

The first supported harness is Codex (`codex app-server`). The API is versioned under `/api/execution/v1` and is off by default.

## Enabling it

1. Create a client token and register its hash:

   ```bash
   TOKEN=$(openssl rand -hex 32)
   echo "$TOKEN"            # give this to the application, server-side only
   HASH=$(printf %s "$TOKEN" | sha256sum | cut -d' ' -f1)
   cat > ~/.codekin/execution-clients.json <<EOF
   [{ "id": "myapp", "tokenSha256": "$HASH", "harnesses": ["codex"], "maxQueued": 50 }]
   EOF
   chmod 600 ~/.codekin/execution-clients.json
   ```

2. Set `EXECUTION_ENABLED=1` (plus any settings below) in Codekin's environment and restart it.

| Setting | Default | Meaning |
|---|---|---|
| `EXECUTION_ENABLED` | off | Mount `/api/execution/v1` |
| `EXECUTION_CLIENTS_FILE` | `~/.codekin/execution-clients.json` | Client list (re-read when it changes) |
| `EXECUTION_CODEX_HOME` | unset | Separate `CODEX_HOME` for jobs (see below) |
| `EXECUTION_CONCURRENCY` | `1` | Jobs running at once (1–8) |
| `EXECUTION_WARM_MINUTES` | `60` | Reuse a warm harness process for up to this long (0 = a new process per job) |
| `EXECUTION_MAX_QUEUED` | `100` | Queued + running jobs across all clients |
| `EXECUTION_BACKGROUND_BUDGET_PERCENT` | `80` | Hold `background` jobs while the subscription usage window is at or above this percent |
| `EXECUTION_RETENTION_DAYS` | `7` | Delete job payloads after this many days (1–7) |

### A separate Codex home (optional)

Jobs use your normal Codex home and its sign-in by default. That home's MCP servers, plugins, hooks, skills and environment details are switched off or left out for each job, so you don't need a second home.

Use one only if:

- you keep a global `AGENTS.md` in your Codex home. Codex would put it in every job's context, so such jobs fail with `UNSUPPORTED_CAPABILITY` until you remove the file or point jobs at a home without it;
- or you want jobs on a different ChatGPT account, so they don't share your sessions' usage window.

Sign the new home in separately; never copy `auth.json` between homes, because each sign-in rotates its own refresh token.

```bash
mkdir -p ~/.codekin/execution-codex
CODEX_HOME=~/.codekin/execution-codex codex login --device-auth
# then set EXECUTION_CODEX_HOME=~/.codekin/execution-codex and restart Codekin
```

## Authentication

Send `Authorization: Bearer <client token>`. Only tokens from the clients file are accepted on these routes. Codekin's admin token and session tokens are not accepted here, and client tokens open nothing else. After 20 failed token attempts in a minute, an IP gets `429` for the rest of that minute, even with a valid token.

Removing a client from the file revokes it on its next request. A file that fails to parse disables every client until it is fixed.

Jobs belong to the client that created them. Pass `X-Execution-User: <userRef>` on reads to also scope lookups to one of your users. A job outside your scope returns `404`.

## Isolation (inference profile)

For every Codex job, Codekin:

- runs the job on a new ephemeral thread whose base instructions are the job's `instructions`, with `sandbox: read-only` and `approvalPolicy: never`, in a new empty working directory that is deleted afterwards;
- runs that thread in a warm `codex app-server` process, reused for up to `EXECUTION_WARM_MINUTES`. A process is reused only after a turn that ran to completion without a guard trip. Any guard trip, cancellation, deadline or incomplete turn stops it before the job is reported. A change in the CLI's features or the configured MCP servers starts a new one. Finished threads are unloaded (`thread/unsubscribe`), so no job's process holds another job's conversation;
- disables every tool-bearing Codex feature the installed CLI reports as enabled, turns web search off, and disables configured MCP servers;
- leaves the home's skills list, project docs and environment context (working directory, shell, date) out of the model's context;
- removes `OPENAI_API_KEY`, `CODEX_API_KEY` and `OPENAI_BASE_URL` from the process environment, so the CLI cannot fall back to API-key billing;
- passes the job's schema as `outputSchema` for JSON jobs.

Some current models are still offered Codex's built-in collaboration and code-mode tools (`spawn_agent`, `exec`, …) whatever the config says. Their hosts are disabled, so they can't run commands, read files or reach the network, but the model can call them.

A runtime guard therefore fails the job **closed** with `UNSUPPORTED_CAPABILITY` and stops the process, along with anything it started, if any of these appear:

- Codex loads an instruction file (`AGENTS.md`) into the thread;
- an MCP server starts;
- the turn makes a second model request. A tool-less turn makes exactly one, and a tool call always causes another, even a call that produces no item;
- any thread in the process produces an item other than the user message, reasoning or the answer (for example a command, file change or tool call);
- the harness sends the client any request.

Treat job input as untrusted data. Isolation is enforced by the steps above; telling the model not to use tools is not relied on. Re-check `/capabilities` after upgrading the Codex CLI: the probe job runs through the same guard.

## Billing

Jobs require `"billingPolicy": "subscription-only"`. Before each turn Codekin checks the account (`account/read`, cached for a minute) and its usage window (`account/rateLimits/read`, kept current by the harness's per-turn usage updates). A usage reading more than a minute old is read again, and if that read fails the mode is `unknown`. The billing mode is `subscription` only when all of these hold:

- the account is a ChatGPT sign-in;
- the plan is not usage-based;
- the account has no purchasable credits that could be spent past the plan's limit.

Otherwise the mode is `metered` or `unknown`, and the job fails with `UNSUPPORTED_CAPABILITY` before any turn starts.

## Endpoints

### `GET /capabilities`

Returns:
- `protocolVersion`;
- per allowed harness: `available`, CLI `version`, `account {type, planType}`, `billingMode`, `models`, `profiles`, `outputTypes` and any `error`;
- the schema subset;
- `capacity`;
- the latest `rateLimits` (`usedPercent`, `windowDurationMins`, `resetsAt`);
- request `limits`.

`profiles` contains `"inference"` only after a probe job has passed the guard on the installed CLI. Probes are cached for 10 minutes. Emails and credentials are never returned.

### `POST /jobs`

An `Idempotency-Key` header is required (at most 200 characters).

```json
{
  "userRef": "u_123",
  "workload": "mail.classify",
  "harness": "codex",
  "model": null,
  "effort": "low",
  "instructions": "Classify the email. Answer with JSON matching the schema.",
  "input": "From: billing@example.com\nSubject: Invoice …",
  "output": { "type": "json", "schemaName": "mail_classify", "schema": { "type": "object", "additionalProperties": false, "required": ["action"], "properties": { "action": { "type": "string", "enum": ["archive", "reply"] } } } },
  "priority": "background",
  "deadlineAt": "2026-01-01T12:00:00Z",
  "billingPolicy": "subscription-only"
}
```

**Fields:**
- `model` and `effort` are optional; `null` means the harness default. Use a model ID from `/capabilities`.
- Text jobs use `"output": { "type": "text" }`.
- `priority` is `interactive` or `background`. Interactive jobs run first.
- `deadlineAt` is required and at most 1 hour ahead.

**Limits:**
- `instructions` + `input`: 256 KB;
- schema: 32 KB;
- output: 256 KB.

**Schema subset:**
- Allowed keywords: `type` (single or array, `"null"` allowed), `properties`, `required`, `additionalProperties`, `items`, `enum`, `anyOf`, `minimum`, `maximum`, `description`, `title`.
- Every object must set `additionalProperties: false` and list all of its properties in `required`. Express optional values as `["string", "null"]`.
- The top level must be an object.
- Any other keyword is refused with `400 UNSUPPORTED_CAPABILITY`, so no constraint is silently ignored.

**Responses:**

| Status | Meaning |
|---|---|
| `202 {job}` | New job accepted |
| `200 {job}` | Same key and same request: returns the existing job, so retries are safe. `deadlineAt` is not part of the comparison. |
| `409 IDEMPOTENCY_CONFLICT` | Same key, different request |
| `429` | Queue full (has `Retry-After`) |
| `400` | Invalid request |

Keys are scoped to client + `userRef` and are kept for 7 days.

### `GET /jobs/:id[?wait=seconds]`

Returns `{job}`. With `wait` (at most 30), the request long-polls until the job is terminal or the wait elapses.

### `POST /jobs/:id/cancel`

Idempotent.
- A queued job is canceled at once.
- A running job's process is stopped first; the job reads `canceled` only after it has exited.
- A result committed before the cancel wins.

### Job object

| Field | Notes |
|---|---|
| `id`, `status`, `waitReason` | `queued → running → succeeded \| failed \| canceled \| expired`; `waitReason` is `capacity`, `budget`, `quota` or `throttled` while queued |
| `workload`, `harness`, `model`, `priority` | `model` is the model that actually ran |
| `attempts` | At most 2 |
| `createdAt`, `startedAt`, `finishedAt`, `deadlineAt`, `cancelRequestedAt`, `queueMs`, `execMs` | |
| `output` | Parsed JSON or trimmed text; only when `succeeded` |
| `raw` | The answer as returned |
| `usage` | `{inputTokens, outputTokens}` or `null` |
| `billingMode` | `subscription` when the turn ran on the subscription |
| `error` | `{code, message, retryable, retryAfter}` |
| `payloadExpired` | `true` once retention removed the payloads |

**Success** means the output parsed and validated against the schema, or that text output is non-empty. Interrupted, incomplete or guarded turns never succeed.

**Error codes:**

| Code | Meaning |
|---|---|
| `AUTH_REQUIRED` | The harness is not signed in |
| `QUOTA_EXHAUSTED` | Subscription limit reached. `retryAfter` is the reset time the harness reported. New jobs for that harness wait (`waitReason: "quota"`) until then. |
| `UNSUPPORTED_CAPABILITY` | Unsupported request or schema, guard trip, provider policy refusal, or billing mode not allowed |
| `INVALID_OUTPUT` | Output did not parse or validate |
| `DEADLINE_EXCEEDED` | The deadline passed while running; status `expired` |
| `RUNTIME_UNAVAILABLE` | The harness could not start, or the provider is temporarily failing |
| `EXECUTION_INTERRUPTED` | The process exited, or Codekin restarted mid-job |

**Retries.** `INVALID_OUTPUT`, `EXECUTION_INTERRUPTED` and transient `RUNTIME_UNAVAILABLE` errors are retried once within the deadline.

**Throttling.** When the provider throttles a harness (HTTP 429 after the CLI's own retries, or an overloaded server), Codekin holds that harness instead of retrying at once: queued jobs wait with `waitReason: "throttled"` for 30 s, doubling while the throttling goes on (at most 5 min), and the first success lifts the hold. The throttled job is retried after the hold if its deadline allows; a job whose deadline comes first fails with `RUNTIME_UNAVAILABLE` and `retryAfter` set to the end of the hold.

**Restart recovery.** After a Codekin restart, jobs that were running are requeued if an attempt and time remain; otherwise they fail with `EXECUTION_INTERRUPTED`.

## Capacity

- Jobs run `EXECUTION_CONCURRENCY` at a time, separately from coding sessions. Coding sessions are not counted or limited by this API.
- Jobs and your own sessions share the same subscription usage window. Above `EXECUTION_BACKGROUND_BUDGET_PERCENT`, `background` jobs stay queued with `waitReason: "budget"` while `interactive` jobs continue. They resume when the window has room again, or expire at their deadline.

Each Codex job carries a fixed per-turn overhead of about 3,500 input tokens (Codex's own system and tool instructions), in addition to your prompt. Batch small items into one job where you can.

## Retention

Instructions, input and schema are deleted as soon as a job ends. Output and raw answers are deleted after `EXECUTION_RETENTION_DAYS`. A minimal record (key, request hash, status, timestamps) stays until 7 days, so retries keep deduplicating. Logs never contain prompts, outputs or tokens.
