# Relay Audit — Verification Pass

**Date:** 2026-08-08
**Scope:** Verification of a prior static audit of the hosted relay (`server/relay/`)
**Anchor commit:** `c2a7e8c` — confirmed to be the current tip of `origin/main`
**Method:** Code review at the anchor plus execution of the relay test suite and a purpose-written exploit test

## Summary

All four findings from the prior audit are confirmed. One was reproduced dynamically as a working
exploit; the other three are confirmed by code path but depend on runtime conditions or a product
decision. Two of the prior audit's open questions are resolved as *not* findings. One additional
minor finding was identified.

The existing relay test suite (14 files, 139 tests) passes in full at the anchor commit, so none of
these issues are caught by current tests.

| # | Finding | Severity | Status | Resolution |
|---|---------|----------|--------|------------|
| 1 | Any active user can delete any machine | High | Confirmed — reproduced | Fixed |
| 2 | Disabled users retain access until cookie expiry | Medium-High | Confirmed by code path | Fixed |
| 3 | Browser→machine stream backpressure not enforced | Medium | Confirmed by code path | Fixed |
| 4 | Share revocation does not affect live connections | Medium | Confirmed; product decision needed | Open |
| 5 | Machine deletion writes no audit event | Low | Confirmed (new) | Fixed |

Findings 1, 2, 3 and 5 are fixed in the same change as this report; see **Resolution** at the
bottom. Finding 4 is left open deliberately — it needs a product decision, not a patch.

---

## 1. Any active user can delete any machine — High

`server/relay/pairing-routes.ts:112` guards `DELETE /api/machines/:machineId` with `requireActiveUser`
only, then calls `removeMachine` (`server/relay/pairing.ts:202`) with no ownership check.
`removeMachine` deletes the machine row and its `machine_credentials` in a transaction, so the
connector loses its credential and the owner must re-pair from scratch.

**Reproduced.** A throwaway test paired a machine to an owner, then issued the DELETE as a second,
unrelated `role: member` / `status: active` user. Result: HTTP 200, and `listMachines(db)` dropped
from 1 to 0.

Machine IDs are `randomUUID()` (`server/relay/pairing.ts:131`), so they are not guessable. The
practical attacker is therefore a share grantee, who receives the owner's machine ID from
`GET /api/machines` (`server/relay/machine-routes.ts:19`, which returns machines where
`sharedMachineIds.has(m.id)`). Being granted view access to one shared session is enough to unpair
the owner's machine.

Note the contrast with `DELETE /api/shares/:shareId` (`server/relay/share-routes.ts:189`), which
*does* check the actor and returns 403 with "Only the user who shared this session can revoke it".
The machine route is missing the equivalent check.

**Fix:** load the machine, require `owner_user_id === req.session.user.id`, and return 403 otherwise.

## 2. Disabled users retain relay access until cookie expiry — Medium-High

`requireActiveUser` (`server/relay/relay-auth-routes.ts:211`) reads `req.session.user.status`, a
snapshot written into the session at login. The WebSocket upgrade path does the same
(`server/relay/relay-server.ts:164`). Neither re-reads the `users` table.

Session cookies are `rolling: true` with `maxAge` 30 days (`server/relay/relay-server.ts:91-99`), so
an active user's session renews on every request and can outlive a revocation indefinitely.

Two revocation paths were examined, and neither works promptly:

- **Removing the login from the env allowlist does not revoke at all.** `upsertUserFromGithub`
  (`server/relay/control-plane-db.ts:225-231`) only ever upgrades status automatically; an `active`
  user stays `active` on subsequent logins regardless of the allowlist. This is deliberate and
  documented in the function's comment, but it means de-allowlisting is not an off switch.
- **Setting `status = 'disabled'` directly in the DB** does persist across future logins, but has no
  effect on already-issued sessions or already-open browser WebSockets.

**Fix:** re-read user status from the DB in `requireActiveUser` and in `authenticateUpgrade`, or
delete the user's rows from the session store on status change and close their live sockets.

## 3. Browser→machine stream backpressure is not enforced — Medium

The machine→browser direction is protected: `server/relay/browser-hub.ts:246` checks
`isBackedUp(client.socket)` on every frame and tears the channel down when a browser stops draining.
Channel *open* is likewise guarded on the machine socket (`server/relay/connector-hub.ts:260`).

The browser→machine direction on an already-open channel is not.
`BrowserHub.forwardChannelData` (`server/relay/browser-hub.ts:269`) forwards straight through to
`ConnectorHub.sendChannelData`, which calls `machine.socket.send` at
`server/relay/connector-hub.ts:274` without consulting `isBackedUp`. The helper exists at
`server/relay/rate-limit.ts:77` with an 8 MB ceiling and is simply not applied here.

The prior audit called the growth "unbounded"; more precisely it is bounded by the per-user frame
limiter (`BROWSER_FRAME_LIMIT`, 40 frames/s sustained, burst 120 —
`server/relay/rate-limit.ts:91`) but not by bytes. With `maxPayload` set to
`MAX_PROXY_BODY_BYTES * 1.4` ≈ 11 MB (`server/relay/relay-server.ts:145`,
`server/relay/relay-protocol.ts:180`), a browser sending large frames to a stalled connector can
grow the relay's outbound buffer for that machine at a rate the byte ceiling was meant to prevent.

**Fix:** check `isBackedUp(machine.socket)` in `sendChannelData` and close the channel, mirroring the
machine→browser path.

## 4. Share revocation does not affect live connections — Medium

Access is resolved once, during browser hello (`server/relay/browser-hub.ts:115`), and stored on the
client record. Every subsequent proxied request and stream channel derives its principal from that
cached value via `toPrincipal(client.user, client.access)`
(`server/relay/browser-hub.ts:213`, `:262`).

`DELETE /api/shares/:shareId` (`server/relay/share-routes.ts:180-193`) calls `deleteShare` and
returns. `BrowserHub` exposes no revoke or per-user disconnect hook — its only teardown method is
`close()`, used for shutdown. A grantee who keeps their tab open therefore keeps their granted
permissions after revocation or share expiry, until they reconnect.

Existing coverage in `server/relay/sharing-e2e.test.ts` asserts revocation only for *new*
connections, which is consistent with this being the intended semantics rather than an oversight.

**This needs a product decision, not just a patch:** is "revocation takes effect on reconnect"
acceptable? If not, `share-routes` needs to notify `BrowserHub` to re-resolve access and close
affected channels.

## 5. Machine deletion writes no audit event — Low (new)

`POST /api/machines/pair/approve` records a `machine_paired` audit event
(`server/relay/pairing-routes.ts:88`), but the `DELETE /api/machines/:machineId` route records
nothing. The most destructive machine-lifecycle operation is the one with no audit trail, which also
means finding 1 would be exploitable without leaving a record.

**Fix:** call `recordAuditEvent` on successful deletion, alongside the ownership check from finding 1.

---

## Open questions resolved as *not* findings

**CSRF on cookie-authenticated REST routes.** Adequately mitigated. The session cookie is
`sameSite: 'lax'` (`server/relay/relay-server.ts:95`), which withholds it from cross-site POST and
DELETE requests; all state-changing relay routes use those methods. No CORS headers are set, so
cross-origin `fetch` cannot read responses either, and no state-changing route is reachable by GET.
The WebSocket upgrade path — which `sameSite` does not protect — has an explicit `Origin` check
against `config.publicUrl` (`server/relay/relay-server.ts:158-159`). No CSRF tokens are needed given
this configuration.

**Machine-side enforcement of path/session filtering.** Genuinely implemented, not UI-only.
`server/relay/connector-policy.ts` enforces on the connector: `checkRestPolicy` restricts grantees to
a small prefix allowlist (`GRANTEE_READ_PREFIXES` / `GRANTEE_WRITE_PREFIXES`), `filterSessionList`
narrows `/api/sessions/list` responses to granted session IDs and returns `null` (refuse) on an
unexpected shape, and `checkClientFrame` gates every client frame type against per-session
permissions with an owner-only default branch. Unrecognized tools classify as
`approve_mutating_tool`, i.e. fail-closed. This is covered by `connector-policy.test.ts`.

## Test results

```
npx vitest run server/relay
Test Files  14 passed (14)
     Tests  139 passed (139)
```

Run in a worktree whose `server/relay` tree is byte-identical to the anchor commit. All findings
above survive a fully green suite.

## Resolution

Fixed in this change:

- **1 + 5** — `DELETE /api/machines/:machineId` now loads the machine, requires
  `owner_user_id` to match the session user, and returns 403 otherwise. The refusal is recorded as
  an `access_denied` audit event and a successful removal as a new `machine_removed` kind, so the
  operation is no longer invisible either way.
- **2** — `requireActiveUser` became `createRequireActiveUser(db)` and re-reads the user row on
  every protected request instead of trusting the login-time session snapshot; the refreshed row is
  written back to the session so `/api/me` agrees with the database. A deleted user row now 401s.
  The browser WebSocket upgrade (`authenticateUpgrade`) re-reads status the same way.
- **3** — `ConnectorHub.sendChannelData` checks `isBackedUp(machine.socket)` and drops the channel
  via a new `dropChannel` helper, mirroring what `BrowserHub` already did in the other direction.

Verification: the three regression tests were each confirmed to fail against the unfixed source and
pass against the fixed source. Full suite 2770 tests / 125 files green; `npm run build` clean; lint
unchanged at 0 errors and 540 pre-existing warnings.

Still open:

- **4** — share revocation on live sockets, pending the product decision described above.
- The prior audit also noted that removing a login from the env allowlist never demotes an existing
  active user. That is deliberate and documented in `upsertUserFromGithub`, so it was left alone —
  but it means `status = 'disabled'` is the only revocation path, and it is worth an admin endpoint
  rather than a manual DB edit.

## Corrections to the prior audit

- The prior audit listed "confirm the anchor is right — `origin/main` has unreviewed relay
  follow-ups" as an open question. It is moot: `c2a7e8c` **is** the tip of `origin/main`. Nothing
  relay-related is unreviewed, and none of these findings are already fixed upstream.
- Finding 3's growth is bounded by the frame-rate limiter, not strictly unbounded.
- Finding 2 is broader than stated: allowlist removal is not a revocation path at all, by design.
