# Assessment — Hosted Auth & Session Security Audit (PR #577)

**Date:** 2026-08-29
**Subject:** `.codekin/reports/security/2026-08-29_hosted-auth-session-audit.md` and the implementation merged as PR #577 (`a91fc9b`)
**Method:** Independent re-read of the merged diff, re-execution of the relay test suite, inspection of the deployed production tree and running service

## Verdict

The audit is accurate and honestly scoped, and the implementation does what the report says it does. The merge, build, and deployment claims all check out under independent verification. Three gaps are worth acting on, one of which is a false claim in the session handoff rather than in the audit itself.

## Verified claims

| Claim | Result |
|---|---|
| PR #577 merged to `main` | Confirmed — merge commit `a91fc9b`, `main` now at `da1c31a` |
| Relay suite 209 passing | Confirmed — re-ran `vitest run relay`: 20 files, 209 tests, 27.6s |
| Production rebuilt and restarted | Confirmed — `/srv/repos/codekin` at `da1c31a`; `server/dist` rebuilt 15:03:52, after the 15:02:28 merge; no source file newer than dist |
| Deployed bundle carries the fixes | Confirmed — `REAUTHORIZE_INTERVAL_MS = 5_000`, `isGithubAccountAllowed`, `disconnectUser` all present in `server/dist/relay/*.js` |
| Service healthy post-deploy | Confirmed — `/api/health` 200; `/api/machines` and `/api/auth/logout-all` return 401 unauthenticated |

Code-level checks that support the report's reasoning:

- `resolveMachineAccess` (`server/relay/shares.ts:243`) re-reads user status and re-evaluates grant expiry against the current clock, so the 5-second sweep genuinely catches account disablement, share deletion, and `expires_at` — it is not merely re-reading a cached row.
- Socket close tears down connector channels (`server/relay/browser-hub.ts:215`), so forcing a reconnect really does discard the connector's cached grant. The report's claim that permission *reductions* cannot survive is sound.
- The access comparison fails closed: any difference at all, not just `kind: 'none'`, closes the socket (`browser-hub.ts:114`).
- `github_id` is `INTEGER` in the schema, so the new existence probe binds correctly and does not silently miss.

## Findings

### A-01 — The handoff claims a startup allowlist reconciliation pass that does not exist — Medium

The session handoff states that "removed-allowlist users are demoted and their sessions deleted at relay startup (reconciliation pass)." No such code is present: `grep -rn "reconcil" server/` returns nothing outside `node_modules`. The audit report itself does **not** make this claim — HSA-03 correctly says allowlist removal is only "mitigated by admin revocation in PR #567."

The shipped behaviour is therefore what HSA-03 describes: removing an ID from `ALLOWED_GITHUB_IDS` is not a revocation operation at all, not even at restart. Operators must use the owner/admin disable endpoint from #567. Anyone acting on the handoff would believe a restart revokes access when it does not.

**Recommendation:** correct the operational note, and either implement the reconciliation pass or document explicitly that the env allowlist governs admission only, never revocation.

### A-02 — The signup block grandfathers every row open signup already created — Low (no production exposure)

`server/relay/relay-auth-routes.ts:178`:

```ts
const existing = db.prepare('SELECT id, status FROM users WHERE github_id = ?').get(profile.id)
if (!existing && !isGithubAccountAllowed(profile.id, accessPolicy)) {
  await destroySession(req)
  failLogin(res, 'access_not_allowed')
  return
}
```

The gate is `!existing && !allowed`. Rows that the previously-open signup path already inserted — which is precisely what HSA-04 found — bypass it permanently. Those identities can still complete OAuth and receive a valid session cookie indefinitely.

Impact is bounded: such users are `pending`, and `requireActiveUser` plus `resolveMachineAccess` reject them from every protected route, machine, and share. No repository exposure. But the answer to the original question should be stated as "new account creation is blocked *going forward, for identities not already in the users table*," not "blocked."

HSA-04's own recommendation to "add cleanup/limits for abandoned OAuth sessions and pending users" was not implemented, and the audit never inspected the production `users` table to see how many pending rows accumulated during the open-signup window.

**That question is now closed.** A read-only aggregate over a copy of the production control-plane DB (`~/.codekin-relay/control-plane.db`, 2026-08-29) returns:

```text
users by status/role: [{"status":"active","role":"owner","n":1}]
total users:      1
web_sessions:     7
session_shares:   0
```

Exactly one user exists — the owner — and there are no pending rows. Open signup was live but never exercised by anyone, so nothing was grandfathered and there is no production exposure. The finding is therefore latent design debt, not an incident, and the severity drops to Low.

**Recommendation:** tighten the gate to also reject `existing && status === 'pending' && !allowed`, so the grandfather clause cannot bite if a pending row is ever created by another path. No production data cleanup is needed.

### A-03 — `logout-all` is self-service only, and nothing calls it — Low

`POST /api/auth/logout-all` reads `req.session.user?.id`, so it acts exclusively on the caller's own account. There is no operator-facing variant, and the only references to the route in the tree are the route itself and its test — no frontend caller exists.

Against the threat HSA-05 describes (a copied cookie, which signing prevents forging but not replaying), this helps only if the legitimate user notices the compromise and invokes it — which they currently cannot do from the UI. An attacker holding the stolen cookie can equally invoke it. The report's "Partially fixed" label is fair, but in practice this is an unreachable primitive today; the working defence against cookie replay remains the admin disable path from #567.

Two facts sharpen this. First, the production DB currently holds **7 `web_sessions` rows for a single user** — seven outstanding cookies on a rolling 30-day lifetime, with no inventory, no expiry visibility, and no reachable way to clear them. Second, `PATCH /api/users/:id` (`user-routes.ts:139`) updates `status` and calls `browserHub.reauthorize`, but never deletes the target's stored session rows: `SqliteSessionStore` is not injected into `createUserRouter`. Disabling a user therefore leaves every one of their cookies in the store. `requireActiveUser` blocks them while disabled, but re-enabling the account silently revives every previously issued cookie.

**Recommendation:** inject the store into `createUserRouter` and call `destroyUserSessions(target.id)` whenever `nextStatus !== 'active'`, so the existing primitive backs the admin revocation path. Separately, wire a "Sign out everywhere" control into hosted Settings so the self-service half is reachable at all.

### A-04 — Access equality is compared by `JSON.stringify` — Low (latent)

`browser-hub.ts:114` compares the freshly resolved access against the cached one with `JSON.stringify(access) === JSON.stringify(client.access)`. The grant map is built by iterating `listSharesFor`, which orders by `created_at DESC`; `created_at` is `datetime('now')` with one-second granularity, so two shares on the same machine created within the same second have no defined tiebreak.

If that order ever varies between sweeps, the serialized forms differ and the socket is closed every five seconds — a reconnect loop, not a security failure (the comparison fails closed). SQLite is stable here in practice, so this is latent rather than live.

**Recommendation:** compare on a canonical form (sorted keys and sorted permission arrays), or add a deterministic tiebreak to the `ORDER BY`.

## Notes on the audit document itself

- Limitations are stated honestly: the report says plainly that fixes were verified against the in-process harness rather than production, that production checks were unauthenticated and non-destructive, and that a staging smoke test should still exercise OAuth rejection and live revocation before rollout. That smoke test did not happen; production rollout did. That is a defensible call given the test coverage, but the residual risk is real and unretired.
- The report is anchored at `9384465`, a pre-rebase commit, with statuses retro-fitted to name #566/#567. The "Remediation implemented" section resolves the ambiguity, but a reader landing on the findings table alone could misattribute which PR delivered which control.
- The severity re-rating of HSA-02 from Medium (2026-08-08) to High is justified and explained against the stated requirement.

## Remediation plan

Ordered by value, not severity. A-03 is the only one with live production relevance.

1. **Back admin disable with session destruction** (A-03). Inject `SqliteSessionStore` into `createUserRouter`; on `nextStatus !== 'active'`, call `destroyUserSessions(target.id)` alongside the existing `reauthorize`. Closes the re-enable-revives-old-cookies path and makes disable a true revocation. Small, well-tested surface.
2. **Expose "Sign out everywhere"** (A-03). A button in hosted Settings posting to `/api/auth/logout-all`, which already exists and is deployed. Turns an unreachable primitive into a real control over the 7 outstanding cookies.
3. **Correct the allowlist documentation** (A-01). `ALLOWED_GITHUB_IDS` is an *admission* control, never a revocation one — that is a deliberate design decision, documented on `upsertUserFromGithub`, protecting manually promoted users from being demoted by an env edit. Do **not** add automatic demotion; it would silently defeat that escape hatch. Instead state plainly that `PATCH /api/users/:id` is the single revocation surface, and optionally log a startup warning naming active non-owner users absent from the allowlist, so drift is visible without being acted on automatically.
4. **Close the grandfather clause** (A-02). Extend the callback gate to `if ((!existing || existing.status === 'pending') && !isGithubAccountAllowed(...))`. Three lines; no production data to clean up.
5. **Canonicalise the access comparison** (A-04). Sort grant keys and permission arrays before serialising, or add a deterministic tiebreak to `listSharesFor`'s `ORDER BY created_at DESC`. Prevents a latent five-second reconnect loop.

## Residual risk

- Up to five seconds of continued access after a direct database change or share expiry. Explicit revocation endpoints call `reauthorize()` synchronously, so this window applies only to out-of-band DB edits. Acceptable for the current threat model.
- The 5-second sweep is O(clients × queries). At current scale (one browser client) this is free; it is worth revisiting before the hosted instance carries meaningful concurrency.
- Forced reconnect on any grant change means an owner editing share permissions drops the grantee's socket. Correct security behaviour, but a visible UX event that is not documented anywhere user-facing.
