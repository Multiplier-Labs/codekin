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
| `http` | status, latency, TLS days-remaining (`checkTls`) | non-expected status (default: ≥400), unreachable/timeout, certificate < 14 days |
| `pm2` | status, restart count, memory | process missing, status ≠ `online`, memory > `memoryLimitMb`; a restart-count increase publishes a one-off event |
| `disk` | free % | free % < `minFreePct` (default 10) |

Probe *failures* (pm2 absent, `df` unparseable) are breaches too — a broken probe is visible, never silent.

## Sampling & signals

Sampling rides the trigger engine's tick (`registerTickTask`, every 5 minutes) — no dedicated interval loop. Samples persist to the `deployment_samples` table in `runs.db` (30-day retention, pruned at boot).

Breach detection fires on **transitions**, not on every breached sample: `ok → breached` publishes a `probe-breach` signal (once), `breached → ok` publishes `probe-recovered`. Both flow through the durable signal queue (at-least-once, deduped while pending) and land in the orchestrator's notifications. The orchestrator can then inspect current state (`list_deployments`) and history (`get_deployment_samples`) before deciding whether to act.

## API

- `GET /api/deployments` — registry with each probe's latest sample
- `POST /api/deployments` / `PATCH /api/deployments/:id` / `DELETE /api/deployments/:id`
- `GET /api/deployments/discover` — pm2 process proposals
- `GET /api/deployments/samples?probeKey=&limit=` — sample history, newest first
