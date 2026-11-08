# L1 signed-intent audit remediation

Date: 2026-11-08

Baseline: `75c3c38b72e9828f81a8fc552ba80708964eabe3`.

Audit: [PR #823](https://github.com/Multiplier-Labs/codekin/pull/823). Fixes: [PR #824](https://github.com/Multiplier-Labs/codekin/pull/824).

## Result

All seven actionable audit findings are addressed. An independent agent reviewed the implementation, requested corrections, and re-reviewed them with no remaining source-review blockers. Validation is local source review and automated regression testing, not deployment penetration testing or a security certification. The audit specification's separately deferred features remain outside this change.

| Finding | Result and evidence |
| --- | --- |
| F1 — duplicate execution through retry | Retries preserve the operation nonce across browser and passkey credentials. Step-up retries preserve the timestamp and require locally classified privileged actions. Stale retries require authenticated machine time for the original nonce, use that exact time, and start within a bounded interval. Tests cover ordinary refusals, credential transitions, timestamps and account-scoped deduplication. |
| F2 — output after share access ends | Every grantee output frame requires current view authority for its joined session. The stream closes when authority ends. Tests cover untagged output, thinking, expiry, revocation, owner-key removal and a single close notification. |
| F3 — stale session after failed creation | The local handler leaves and clears the old session before attempting creation. A failed creation cannot direct subsequent input or stop to that session. |
| F4 — replay recovery loses live nonces | A separate SQLite store commits each machine/account/nonce before forwarding. Transactions serialize independent connectors; unavailable or corrupt storage refuses signed actions. Recovery no longer reads the audit tail. Tests cover restart, missing/empty/rotated logs, storage failure, capacity and retention boundaries. Logged metadata is bounded. |
| F5 — lost concurrent revocations | IndexedDB transactions merge current state and remove only exact acknowledged revocations. Issued-ledger changes and their retry work commit together across both stores. Renewal cannot overwrite a concurrent revocation. Conflicting supersedes with equal issue timestamps are refused without changing existing machine state; pending conflicts survive until a later grant or full revocation covers them. Tests cover queue interleaving, renewal races, old persisted records in both delivery orders, transaction abort and reopened storage. |
| F6 — unauthenticated removal confirmation | Device pins remain marked pending until a machine signature binds the machine, target key and request nonce. A lost acknowledgement can be retried using a fresh signed proof of absence. Tests cover unsigned responses, lost replies and acknowledgements from another attempt. |
| F7 — competing first-use browser keys | Atomic compare-and-insert returns the committed browser key to all tabs. Eight independent IndexedDB adapters return the same non-extractable private key and produce signatures that verify against its pinned public key. |

## Validation

- Full local suite: **280 files, 4,996 tests passed**.
- Typecheck: `npx tsc -b` passed.
- Changed-file lint: no errors or new warnings. Existing counts match the baseline: one in `connector-policy.ts`, one in `connector-stream.ts`, and four in `ws-message-handler.ts`; the other changed and new files are clean.
- Independent security source re-review: approved, no remaining blockers identified.
- SQLite timing on the development host, 49,000 live entries and 250 committed consumptions: median 2.01 ms, p95 2.93 ms, maximum 4.06 ms. Storage performance on other hosts can differ.

## Upgrade behavior

Existing installations without durable replay state wait through a one-time ten-minute recovery window. The deadline is persisted, so restarts do not extend it. New local pairing initializes fresh state without the delay. Missing state later starts recovery again; corrupt or unavailable storage refuses signed actions until repaired. Operations documentation describes this behavior and the replay file.

No service was deployed or restarted as part of this remediation. CI results and merge state are recorded on the fix PR.
