# Expanding Joe's Value Proposition: From Scheduled Reviews to Fleet Supervisor

**Date:** 2026-08-29
**Scope:** Agent Joe / workflow engine / monitoring surface
**Status:** Proposal for review

---

## 1. The problem, and the reframe

Joe's value proposition today is rigidly built around AI workflows: cron-scheduled review/audit recipes that run per repo. Three structural gaps limit the value delivered:

1. **Workflows trigger regardless of repo activity.** A repo with no commits since the last run still gets a scheduled run dispatched. The engine burns run rows, events, and (when the in-run skip check misses) full Claude sessions producing reports nobody needs.
2. **Joe is blind to everything after the merge.** The repos build apps that are deployed and serving traffic — but Joe has no concept of a deployed app. Load, stability, restarts, certificate expiry, security posture of live endpoints: none of it is observed.
3. **Joe is blind to the ground it stands on.** The machine running Codekin (and the deployed apps) needs disk space, OS updates, security patches, process-manager health. Nobody watches it; the human does that maintenance by hand.

The target value proposition: **Joe is a strong helping hand maintaining multiple active repos, apps, and machines — acting smartly and only when needed, and needing almost no maintenance itself.**

That sentence carries two design principles that govern everything below:

- **Act on signal, not on wall-clock.** Every trigger should trace back to something that actually changed: a commit, a threshold breach, a pending OS patch. Wall-clock cadence survives only as a fallback sweep. A quiet fleet means a quiet Joe.
- **Low-maintenance by construction.** Discovery over configuration: Joe finds repos, processes, and services itself and *proposes* the registry; the human confirms rather than authors. Defaults over tuning; self-adjusting cadence via the existing trust ladder rather than settings sprawl. Adding an asset to Joe's care should be one confirmation, not a config file.
- **Stability from one robust core.** All firing — timers and signals alike — goes through a single durable, crash-recoverable trigger engine (§6) with idempotent dispatch and a self-watchdog, instead of today's dozen scattered interval loops and in-memory events. A supervisor that can silently stall is worse than no supervisor.

## 2. Current state (verified against the code)

### 2.1 How triggering actually works

- The cron scheduler (`server/workflow-engine.ts:799–831`) polls every 60 s and dispatches purely on wall-clock. No activity signal is consulted before dispatch.
- The **only** activity check lives *inside* the run, in the `validate_repo` step (`server/workflow-loader.ts:274–292`): `git log --since=<sinceTimestamp>`; empty → `WorkflowSkipped`. By that point the run row and step rows already exist and `run_queued` has been broadcast.
- `sinceTimestamp` is `schedule.lastRunAt` — the last **fire**, not the last **successful run**. Skips and failures advance it, so the comparison window slides silently past unreviewed commits.
- The first cron fire has no `lastRunAt`, so it always runs, active repo or not.
- Manual triggers (`triggerSchedule`, `workflow-engine.ts:792–797`) omit `sinceTimestamp` entirely — no skip possible, which is arguably correct for manual but worth making explicit.
- No pre-dispatch concurrency cap exists for cron kinds (only `commit-review` has one, in the event handler).

### 2.2 What activity signals exist

- `.git/HEAD` mtime, used by `OrchestratorMonitor.checkPassiveRepos` (`server/orchestrator-monitor.ts:202–232`) to nudge Joe about repos passive ≥ 30 days. Advisory only; also a weak proxy (mtime changes on checkout, not just commit).
- Per-session `_lastActivityAt` (`server/session-manager.ts`) — never aggregated per repo.
- Commit events via the post-commit hook, PR events via webhooks — both consumed by their own stacks, never recorded as "this repo is active."

### 2.3 What deployment/host awareness exists

None. No pm2 introspection, no health/uptime probing, no endpoint checks, no cert monitoring, no log watching, no disk/OS-update awareness. `deployAfter` exists as a `SpawnChildInput` field (`server/codekin-mcp-api.ts:23`) but has no consumer. The pieces that *do* exist and can be reused: the deterministic 15-min `OrchestratorMonitor` loop, the durable notification outbox, trust-gated child spawning with ground-truth verification, the memory store, and the unified run store.

## 3. Proposal part 1 — Activity-aware repo validation

### 3.1 Repo Activity Index

A small server service (`server/repo-activity.ts`) maintaining one record per configured repo:

```ts
interface RepoActivity {
  repoPath: string
  lastCommitAt: string | null      // git log -1 --format=%cI (cheap, local)
  lastCommitSha: string | null
  lastSessionAt: string | null     // max(_lastActivityAt) over sessions with groupDir == repoPath
  lastCommitEventAt: string | null // from the post-commit hook path
  lastPrEventAt: string | null     // from the webhook stack
  tier: 'active' | 'cooling' | 'dormant'
}
```

Updated from three cheap sources: a periodic sweep piggybacked on the existing 15-min monitor tick (one `git log -1` per repo — no fetch, no network), plus event-driven bumps from the commit-event handler and the webhook handler. Session activity is read live when queried. Persisted in `runs.db` so tiers survive restarts.

Tiers (defaults, configurable but shipped with sane values — principle 2):

| Tier | Definition | Behavior |
| --- | --- | --- |
| `active` | any signal within 7 days | full configured cadence |
| `cooling` | 7–30 days | daily kinds throttled to weekly; weekly kinds unchanged |
| `dormant` | > 30 days | scheduled workflows paused; Joe notified once |

Reactivation is automatic: any commit event, session, or PR event on a dormant repo restores `active` and resumes schedules. Nothing to un-pause manually — no maintenance burden.

### 3.2 Pre-dispatch gate (the core fix)

Move the activity decision **before** `startRun` in the cron tick:

1. Scheduler consults the Activity Index; a `dormant` repo → skip dispatch entirely. No run row, no session, no event noise. Record a lightweight `last_skipped_at` + counter on the schedule row so the UI can show "held: repo idle."
2. Replace timestamp-based change detection with **SHA-based**: store `lastReviewedSha` per schedule, set only on *successful* runs. Gate = `HEAD != lastReviewedSha`. This fixes both the sliding-window bug and timezone/`--since` fragility in one move.
3. Keep the in-run `validate_repo` check as a belt-and-suspenders (races between gate and session start), but it should now almost never fire.
4. Manual triggers stay ungated (explicit human intent) — but the run detail should show "manually triggered, change-detection bypassed."

### 3.3 Surfacing

- Automations view: per-repo activity badge (`active` / `cooling` / `dormant`) on `RepoGroup`, "held" state on schedule rows.
- Joe's dashboard: repo list becomes tiered; `checkPassiveRepos` is retired in favor of the index (removing the `.git/HEAD` mtime hack).
- Joe's system prompt gains the index via the Codekin MCP server (`get_repo_activity`), so trust-gated schedule adjustments ("this repo went dormant, I paused its dailies") become possible per Phase 3 of the unification plan.

## 4. Proposal part 2 — Deployed-app monitoring

### 4.1 Deployment registry — discovered, not authored

New config, same shape philosophy as `workflow-config.json`:

```ts
interface DeploymentConfig {
  id: string
  name: string                    // "codekin-prod"
  repoPath?: string               // link back to the repo, optional
  probes: ProbeConfig[]
  enabled: boolean
}

type ProbeConfig =
  | { type: 'http';  url: string; expectStatus?: number; timeoutMs?: number; checkTls?: boolean }
  | { type: 'pm2';   processName: string }          // restarts, memory, CPU, status
  | { type: 'systemd'; unit: string }
  | { type: 'log';   path: string; errorPattern?: string }  // error-rate over window
  | { type: 'disk';  path: string; minFreePct?: number }
```

Per the low-maintenance principle, the registry is **bootstrapped by discovery**: a one-shot `discover` pass reads `pm2 jlist`, systemd units in a whitelisted namespace, and nginx server blocks, then presents a proposed registry ("I found `codekin`, `codekin-relay`, `codekin-connector` under pm2 and two nginx sites — monitor these?"). The human confirms/edits once; from then on, a new pm2 process or nginx site triggers a *proposal* notification, never silent auto-enrollment.

### 4.2 Two-layer architecture: deterministic probes, AI diagnosis

The critical design decision — **probes are not AI**. A `DeploymentMonitor` service (sibling of `OrchestratorMonitor`, same tick cadence, probes are seconds-cheap) collects samples into a `deployment_samples` table in `runs.db`: status, latency, restart count, memory, cert-days-remaining, error-rate. Threshold evaluation is plain code:

- HTTP: non-2xx, latency > p95 baseline × N, TLS cert < 14 days
- pm2: restart count increased, memory > threshold, status ≠ online
- log: error-rate spike vs trailing window
- disk: free % below floor

**AI enters only on breach.** A threshold breach produces a Joe notification (existing outbox path) with the sample evidence attached. Joe — under the existing trust ladder — decides: ignore (known flapper, recorded in memory), watch (raise probe frequency temporarily), or **spawn a diagnostic child** via the existing `spawn_child` infra with the evidence in its prompt. The child investigates (logs, recent deploys, recent merges via the run ledger), writes an incident report to `.codekin/reports/incidents/`, and — trust permitting — proposes or executes a fix PR.

This keeps costs sane (LLM tokens only on anomalies), keeps monitoring reliable (no LLM in the hot path), and reuses every hard-won piece of Joe's resilience work: outbox, blocked-child handling, ground-truth verification, memory.

### 4.3 Security posture of live apps

Extends the same probe/recipe split:

- **Deterministic**: TLS expiry + protocol floor, security-header check (HSTS, CSP presence), unexpected status on auth endpoints, `npm audit` severity counts — triggered by *dependency changes* (Activity Index) rather than wall-clock.
- **AI recipe**: the existing `security-audit.weekly` workflow gains a deployment section when the repo has a linked deployment — the prompt receives current probe state and recent samples, so the audit covers the live surface, not just the code.

Explicit non-goals: no port scanning, no active exploitation, no probing of hosts not in the registry. Probes only touch what the operator registered.

## 5. Proposal part 3 — Host monitoring & maintenance

Joe runs *on* a machine, and the apps it watches run on machines. The third asset class:

### 5.1 Host probes (deterministic, same monitor)

A `host` probe family in the same `DeploymentMonitor`, sampled into the same table:

- **Resources**: disk free per mount, memory pressure, load average vs core count, inode exhaustion.
- **Updates**: `apt list --upgradable` count, security-update count, `/var/run/reboot-required`, unattended-upgrades status.
- **Runtime estate**: pm2 daemon alive, node version vs LTS window, npm-audit exposure of globally-installed tooling, log partition growth rate.
- **Hygiene**: cert-renewal timer status (certbot/systemd timer), clock skew, zombie/defunct process count.

All read-only shell commands, seconds-cheap, no network beyond apt metadata already on disk.

### 5.2 Maintenance under the trust ladder — never surprise the operator

Host *changes* are where autonomy must be earned, not assumed. Mapped onto Joe's existing escalation ladder:

| Trust level | Joe may |
| --- | --- |
| Observe (default) | Report: "3 security updates pending, disk at 82%, reboot required since Tuesday." Weekly host digest + immediate notification on critical thresholds. |
| Propose | Prepare the exact commands (`apt-get upgrade` list, `pm2 flush`, log rotation config) as a one-click approval in the notification. |
| Routine-execute | Perform pre-approved *classes* of action autonomously: clean package cache, rotate/compress logs, renew certs. Class list is explicit and starts empty. |
| Never (hard floor) | Reboots, service restarts of user-facing processes, kernel/major-version upgrades, anything touching live sessions — always human-approved, regardless of trust. |

The hard floor codifies existing operator feedback (a pm2 restart kills live sessions) as policy, not memory. Every executed action lands in the run ledger with the exact commands and output — auditable like any other run.

**Sudo-free by default.** Joe runs with the Codekin server user's privileges and no more. All host probes are read-only commands that work unprivileged (`df`, `free`, `apt list --upgradable`, reading `/var/run/reboot-required`, `pm2 jlist`, systemd status queries). Routine-execute covers only actions the unprivileged user can already perform (its own pm2 processes, its own log/cache directories). Anything that would need root — package upgrades, cert renewal via certbot, system service changes — is **propose-only**: Joe prepares the exact commands and the human runs them. A narrowly scoped sudoers rule for a specific action class is a deliberate operator opt-in, never a default, never something Joe requests to have configured.

### 5.3 Multi-machine, honestly scoped

Today Codekin manages one host, and Phase E below targets exactly that. But "multiple machines" is in the value proposition, and the hosted relay already gives Codekin a machine-aware topology (`machinesOnline` in the relay health model). The forward path: the probe layer is written against a `MachineTarget` abstraction (local shell today; relay-connected machine later), so extending to N machines is a transport change, not a redesign. Explicitly out of scope for now: agentless SSH probing of arbitrary servers.

## 6. Proposal part 4 — One robust trigger engine

Everything above ultimately reduces to "something fires, a gate decides, a run happens." Today that firing layer is the weakest part of the codebase, and it is where "operates in a super stable way" is won or lost.

### 6.1 What triggering looks like today

- **~12 independent timer loops** across the server (`workflow-engine` 60 s cron tick, `orchestrator-monitor` 15-min poll + aging timer, outbox 60 s flusher, commit-event dedup cleanup, session-archive cleanup, approval persist debounce, …). Each has its own start/stop lifecycle and no shared liveness story; a silently dead interval is invisible until someone notices reports stopped appearing.
- **Timers are durable but have no catch-up policy.** `cron_schedules.next_run_at` survives restarts (good), but after downtime every overdue schedule fires simultaneously on the first tick — a thundering herd of Claude sessions with no concurrency cap.
- **Signals are ephemeral.** Commit events, webhook events, and `workflow_event`s ride an in-memory `EventEmitter`; a crash between receipt and action loses them. Joe's notification outbox is the one durable exception — and it proves the pattern works.
- **Three cron implementations** (engine parser, route validator, and the harness `CronCreate` Joe is prompted to use) that can disagree on edge cases.

### 6.2 The trigger engine

One engine, two input classes, one dispatcher — all state in `runs.db`:

```
TriggerEngine
├─ timers    — generalized cron_schedules: anything periodic registers here,
│             including the monitor sweep, outbox flush, probe ticks
├─ signals   — durable table; producers INSERT (commit event, probe breach,
│             webhook, goal-run event), dispatcher consumes with lease + ack
└─ dispatcher — single loop: due timers + pending signals → gate → dispatch → ack
```

The robustness properties, each a deliberate guarantee:

1. **Durable timers with an explicit catch-up policy.** Per timer: `catchUp: 'collapse'` (missed fires merge into one, the default) or `'skip'` (wait for the next natural slot). Overdue fires after downtime dispatch with jitter and under the concurrency cap — no herd.
2. **At-least-once signals with acknowledgment.** Producers write the signal row first, then processing happens; the dispatcher takes a short lease, and a crash mid-processing means lease expiry and redelivery — never loss. Stale signals expire by TTL instead of firing surprisingly hours later.
3. **Idempotent dispatch.** Every dispatch has a natural key — `(timerId, targetSha)` for repo workflows, `(signalId)` for events — checked against the run ledger. Redelivery of an already-handled signal is a no-op. This is what makes at-least-once safe rather than duplicate-spawning.
4. **Single-flight and backpressure.** Per-repo and global concurrency caps enforced at dispatch (today only `commit-review` has one, in the wrong layer); overflow queues in priority order (signal > timer) rather than dropping or stampeding.
5. **A trigger ledger.** Every decision is recorded with its reason: `fired`, `held: repo dormant`, `held: concurrency`, `collapsed: 3 missed fires`, `deduped`. The Automations UI can finally answer "why didn't this run?" — and "why did it?"
6. **Self-watchdog.** The dispatcher writes a heartbeat row every tick; one independent, trivially simple check (surfaced in the existing health/environment UI and as a Joe notification) flags a stalled engine. The engine reports its own sickness — the low-maintenance principle applied to the machinery itself.
7. **Crash-recovery invariant: no trigger state lives only in memory.** Boot = read tables, resume. This already holds for schedules; the signals table extends it to events, and folding the scattered periodic loops into registered timers extends it to the housekeeping no one currently watches.
8. **One cron implementation.** A single vetted parser module (either the existing hand-rolled one consolidated and edge-case-tested, or a small dependency like `croner`) used by engine, validation, and anything Joe schedules.

Producers stay decoupled: the commit-event handler, webhook handler, and future `DeploymentMonitor` just INSERT signals. Gates stay pluggable: the activity gate (§3.2), concurrency, and trust checks all run in the dispatcher, in one place, before any session spawns.

### 6.3 Migration without a big bang

The engine is an extraction, not a rewrite: `cron_schedules` already has the right shape and becomes the `timers` table; the outbox already proves the durable-queue-with-flusher pattern and becomes a signal consumer; the cron tick's body becomes the dispatcher. Existing stacks migrate producer-by-producer (cron workflows first, then commit events, then probes), each step shippable and revertible.

## 7. Fit with the automation unification plan

This slots into the approved `Automation = trigger × recipe × policy` primitive by adding one trigger type:

```
trigger = schedule | event | goal | delegation | signal   ← new: threshold breach from a probe
```

A diagnostic child or a maintenance action is then just a `signal`-triggered run through the shared engine — exactly the Phase 3 "Joe on top" shape. Nothing here creates a fourth automation stack; one monitor emits signals for apps *and* hosts, and the existing machinery runs them. The unified Automations view gains a "Fleet" dimension (repos / apps / machines) over the same run ledger.

## 8. Phasing

| Phase | Content | Size | Value |
| --- | --- | --- | --- |
| **A0** | Trigger engine core: generalize `cron_schedules` → timers with catch-up policy + jitter, dispatcher with concurrency caps, trigger ledger, heartbeat watchdog, single cron module | M | The stability substrate everything else rides on |
| **A** | Pre-dispatch gate: SHA-based change detection on successful runs, dormant-skip before dispatch, held-reason surfacing (via the trigger ledger). Fixes the sliding-window bug. | S | Immediate: no more no-op runs, no more silently missed commits |
| **B** | Repo Activity Index + tiers + event-driven bumps + UI badges + Joe MCP tool + retire `checkPassiveRepos` | M | Joe knows which repos are alive; cadence follows reality |
| **C** | Signals table + first producers (commit events, webhooks) migrate to durable at-least-once delivery; deployment registry with pm2/nginx discovery + `DeploymentMonitor` probes (http/pm2/log/disk) + samples table + breach → signal → Joe notification | M–L | Events can no longer be lost; Joe watches production |
| **D** | Signal-triggered diagnostic children + incident reports + security probes + deployment-aware security audit | M–L | Full loop: detect → diagnose → propose fix, under trust |
| **E** | Host probe family (sudo-free) + trust-laddered maintenance (observe → propose → routine-execute, hard floor) + weekly host digest | M | The machine itself is under care; hand maintenance shrinks |

A0 and A ship together as the first PR series; B is independent of the unification work and can follow immediately. C–E compose with unification Phase 3 but don't block on it (the monitor can notify Joe directly first, migrating to `signal` runs when the shared engine absorbs delegation). Each phase reduces — never adds to — the operator's recurring workload; that is the acceptance test for "not needing much maintenance."

## 9. Open questions

1. **Tier thresholds** — are 7/30 days right, and should they be per-repo configurable from day one or global first?
2. **Cooling-tier semantics** — throttle (proposed) vs. hold-until-next-activity? Throttle is gentler for repos with slow-but-real cadence.
3. ~~Probe execution identity~~ — **resolved**: sudo-free by default (§5.2). Probes and routine-execute stay within the unprivileged Codekin user; root-requiring actions are propose-only; scoped sudoers rules are operator opt-in only.
4. **Baseline learning** — latency/error-rate baselines: fixed thresholds first (proposed), or learned p95 from the samples table once it has a week of data?
5. **Where deployments are configured** — Settings UI section, or `.codekin/deployments.json` per repo, or both (repo file as source, UI as editor)? Discovery makes this less pressing but the storage answer is still needed.
6. **Host digest channel** — weekly digest as a Joe chat notification, a committed report in `.codekin/reports/host/`, or both?
