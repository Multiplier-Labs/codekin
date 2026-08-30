# Deployment Monitoring

Codekin can watch the apps you deploy — not just the repos that build them. The design is two-layered: **deterministic probes** sample cheaply on the trigger engine's tick with no LLM anywhere in the hot path, and **the agent enters only on a breach**, delivered as a durable signal into the orchestrator's notification stream.

Everything runs sudo-free as the Codekin server user: HTTP requests, `pm2 jlist`, and `df`. Anything that would need elevated privileges is out of scope for probes by policy.

## Registry

Deployments live in `~/.codekin/deployments.json`:

```json
{
  "deployments": [
    {
      "id": "codekin-prod",
      "name": "Codekin Production",
      "repoPath": "/srv/repos/codekin",
      "enabled": true,
      "probes": [
        { "type": "http", "url": "https://app.example.com/api/health", "checkTls": true },
        { "type": "pm2", "processName": "codekin", "memoryLimitMb": 1024 },
        { "type": "disk", "path": "/", "minFreePct": 10 }
      ]
    }
  ]
}
```

`repoPath` links a deployment back to its source repo, connecting incidents to recent merges.

`GET /api/deployments/discover` proposes monitorable pm2 processes (marking ones already configured). Discovery never auto-enrolls — the operator (or the agent, under trust) confirms via `POST /api/deployments`.

## Probes

| Type | Samples | Breach conditions |
| --- | --- | --- |
| `http` | status, latency, TLS days-remaining (`checkTls`), security headers (`checkHeaders`) | non-expected status (default: ≥400), unreachable/timeout, certificate < 14 days, missing HSTS/CSP headers |
| `pm2` | status, restart count, memory | process missing, status ≠ `online`, memory > `memoryLimitMb`; a restart-count increase publishes a one-off event |
| `disk` | free % | free % < `minFreePct` (default 10) |
| `log` | new error-pattern lines per window (`errorPattern` regex, default error/exception/fatal) | more than `maxErrorsPerWindow` (default 10) new matches since the last sample; missing file / bad pattern |
| `host` | memory available %, load per core, apt upgradable/security counts (cached 6h), reboot-required | memory < `minMemAvailablePct` (10), load/core > `maxLoadPerCore` (3), pending security updates, reboot required |

Probe *failures* (pm2 absent, `df` unparseable, log file missing) are breaches too — a broken probe is visible, never silent.

The log probe's read offset travels in the sample metrics, making its state exactly as durable as the samples table: the first sample baselines at end-of-file (history is never scanned), a shrunken file is treated as rotation, and reads are capped at 5 MB per window.

## Sampling & signals

Sampling rides the trigger engine's tick (`registerTickTask`, every 5 minutes) — no dedicated interval loop. Samples persist to the `deployment_samples` table in `runs.db` (30-day retention, pruned at boot).

Breach detection fires on **transitions**, not on every breached sample: `ok → breached` publishes a `probe-breach` signal (once), `breached → ok` publishes `probe-recovered`. Both flow through the durable signal queue (at-least-once, deduped while pending) and land in the orchestrator's notifications. The orchestrator can then inspect current state (`list_deployments`) and history (`get_deployment_samples`) before deciding whether to act.

## Host monitoring & the maintenance ladder

The `host` probe treats the machine itself as a monitored asset. Register it on any deployment (conventionally a dedicated `"host"` entry):

```json
{ "id": "host", "name": "This machine", "enabled": true, "probes": [{ "type": "host" }, { "type": "disk", "path": "/" }] }
```

Maintenance autonomy follows the trust ladder from the expansion plan, and this phase implements the first two rungs:

- **Observe** — breaches and metrics flow to the orchestrator like any probe.
- **Propose** — breaches that need privileges to fix carry the exact operator-run command in their text (e.g. `sudo apt-get update && sudo apt-get upgrade`, or a reboot window). The orchestrator relays and tracks; it never executes.
- **Routine-execute** is deliberately not implemented: the pre-approved action-class list starts empty, and the hard floor (restarts, reboots, anything touching live sessions) always requires a human regardless of trust.

A **weekly host digest** (memory, load, pending updates, reboot state, deployment-probe health) is delivered to the orchestrator as a notification; the last-sent timestamp persists across restarts. No digest is sent when no host probe is configured.

## Incident response

A breach always notifies the orchestrator, which can inspect state and spawn a diagnostic child under its normal trust rules. Additionally, a deployment with **`"autoDiagnose": true`** (operator opt-in, requires `repoPath`) spawns the diagnostic child automatically the moment a breach signal is processed:

- The child receives the breach evidence (probe, breaches, metrics, recent sample history) inline in its task.
- It investigates — logs, recent commits/merges, deploy correlation — and writes an incident report to `.codekin/reports/incidents/<date>_<deployment>.md`, landing it as a PR. A clear low-risk fix may be implemented on the same branch; anything else becomes a "Proposed remediation" section.
- **Hard constraints**: the child diagnoses, it never operates — no service restarts, no host changes, no edits to monitoring config. Those remain operator-approved actions.
- A 6-hour per-probe cooldown prevents a flapping probe from spawning children repeatedly; the concurrent-children cap (5) applies as everywhere.

The orchestrator is told when an auto-diagnosis starts (and when it can't — e.g. at the children cap), so there is never a silent parallel investigation.

Security audits are deployment-aware: when a repo with a linked, monitored deployment runs its `security-audit` workflow, the prompt receives current probe state (`<deployment-status>` block), so the audit covers the live surface — TLS posture, headers, resource pressure — alongside the code.

## API

- `GET /api/deployments` — registry with each probe's latest sample
- `POST /api/deployments` / `PATCH /api/deployments/:id` / `DELETE /api/deployments/:id`
- `GET /api/deployments/discover` — pm2 process proposals
- `GET /api/deployments/samples?probeKey=&limit=` — sample history, newest first
