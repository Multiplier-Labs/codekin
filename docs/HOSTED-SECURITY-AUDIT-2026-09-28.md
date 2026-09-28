# Hosted workspace and session isolation audit

Audited commit: `453c5197d2aee3bdb0431e8edcec02c1259dbb7f`.

**Result: isolation is not sufficient for restricted session sharing.** Six findings were confirmed with local reproductions. A user holding only a view grant can bypass the connector's REST restrictions and access unshared data on that machine. Private approval prompts can also leak passively. A removed workspace member retains some control-plane access through legacy ownership checks.

This was a source audit and local test exercise, not a production penetration test. No production accounts, credentials, databases, machines, or customer data were used. All six findings have since been fixed in the same change as this report; see [Remediation](#remediation).

## Findings

| ID | Severity | Boundary violated |
| --- | --- | --- |
| F1 | High | Shared-session viewer → owner-only local REST endpoints |
| F2 | Medium | Shared-session viewer → all session names, IDs and working directories on the machine |
| F3 | High | Shared-session viewer → private session approval prompts and tool inputs |
| F4 | Medium | Removed workspace member → other users' machine audit events |
| F5 | High | Demoted/suspended share creator → elevated grants for another member |
| F6 | Medium | Removed workspace member → deletion of workspace machine registration |

### F1 — URL normalization bypasses both proxy authorization gates

Locations: `server/relay/connector-proxy.ts:125`, `server/relay/connector-policy.ts:60`, `server/relay/connector-policy.ts:107`.

The connector authorizes the raw request path using prefix checks and rejects only literal `..`. It then hands that path to `fetch`, which normalizes encoded dot segments. Consequently the URL authorized by policy and the URL executed against the local server differ. The connector attaches the machine's bearer token to the resulting request.

Confirmed with the real proxy executor, Node fetch, and real local session routes:

* A principal with only `view` on session `shared` requests `GET /api/sessions/list/%2e%2e/archived/private`. The local server receives `/api/sessions/archived/private` and returns the unshared archived transcript.
* The same view-only principal sends `DELETE /auth-verify/%2e%2e/api/sessions/private`. The local session deletion handler is invoked. `/auth-verify` is allowed for grantee mutations without any additional permission.
* An upload grantee sends `PATCH /api/upload/%2e%2e/sessions/private/rename`; the private session is renamed.

The first two reproductions require no editor, shell, or upload permission. An active grant to any session on the target machine is sufficient to reach its proxy. These paths are carried inside relay WebSocket JSON; a browser's address-bar URL normalization does not prevent the attack. Reachability extends to other local endpoints after normalization, subject to each endpoint's own checks; arbitrary code execution was not tested.

Fix: derive one validated canonical URL before either policy check, authorize that exact pathname and method, and execute that exact URL. Prefer exact routes for grantees, explicitly reject ambiguous path syntax, and do not automatically follow redirects into unauthorized endpoints. Test encoded/mixed dot segments, slashes, fragments, query strings and redirect behavior. Add relay-side enforcement as well so updating only the hosted service can protect clients with older connectors.

### F2 — A trailing slash skips session-list filtering

Locations: `server/relay/connector-policy.ts:64`, `server/relay/connector-proxy.ts:364`.

`GET /api/sessions/list/` passes the grantee prefix allowlist. Express serves the same route as `/api/sessions/list`, but `needsSessionListFilter` only recognizes the exact path without the trailing slash. The entire list is returned. The reproduction returns both the shared session and an unshared session named `Confidential` with `/private/repo` as its working directory; the canonical-path control filters correctly.

This issue is independent of encoded traversal and survives a fix that only rejects `%2e`.

Fix: use the same canonical route identity for request authorization and response filtering. Any accepted spelling of the session-list route must be filtered, or denied before forwarding.

### F3 — Outbound WebSocket frames leak private approval prompts

Locations: `server/relay/connector-stream.ts:100`, `server/prompt-router.ts:181`, `server/prompt-router.ts:420`, `server/ws-server.ts:456`.

The connector checks browser-to-server frames but forwards server-to-browser frames without a grant check. When a local session has no attached clients, `PromptRouter` globally broadcasts its pending approval prompt, including `sessionId`, session name, `toolInput`, question and request ID. The local server sends global broadcasts to every open socket, including a connector channel opened for a different user's shared session.

A grantee can therefore receive private tool arguments (commands, paths, proposed edits and any secrets those arguments contain) without attempting to join the private session. This can happen during normal use. The reproduction authenticates a grantee stream, injects the exact global-prompt frame shape, and confirms the full private frame reaches `onData`. The broadcast source and global fan-out were traced in production code; the reproduction uses an in-process socket stand-in, not a running coding agent.

Fix: carry session identity on data-bearing outbound frames and enforce grants before relaying them. Filter global notifications, including webhook notifications, and bind prompt tracking to the authorized session. Do not rely on the frontend to hide unauthorized frames. Preserve owner behavior and explicitly define which machine-wide notifications are safe for grantees.

### F4 — Removed members retain machine audit-log access

Locations: `server/relay/share-routes.ts:289`, `server/relay/share-routes.ts:317`.

Both `/api/audit-events?machineId=...` and `/api/audit-events/export?machineId=...` authorize only against `machines.owner_user_id`. Removal quarantines the machine but deliberately retains that owner field. Neither endpoint verifies active workspace membership, a live workspace, or quarantine.

Confirmed: remove the machine owner from the workspace, verify `resolveMachineAccess` now returns `none`, and request both audit endpoints as that still-active platform account. Both disclose another user's event, including their IP address. The fixture event is recorded after removal, demonstrating that this is ongoing access rather than only retained personal history.

Fix: require current workspace standing and the intended audit permission for machine-scoped reads and exports. Apply a deliberate workspace-visibility rule to the actor-only endpoint too, separating account-level history from workspace events.

### F5 — Share updates do not recheck the creator's current authority

Location: `server/relay/share-routes.ts:197`.

Share creation validates active membership, `machine.share`, machine ownership and quarantine. Updating a share only checks its historic `sharedByUserId` and the recipient's role cap. Membership demotion or suspension leaves existing shares in place.

Confirmed: create a view-only share, demote its creator to workspace viewer, and verify they no longer have direct machine access. They can still PATCH that share to add `approve_shell` for an active member. `resolveMachineAccess` returns the elevated grant for the recipient. A suspended creator also lacks the required checks by code inspection; the executable case covers viewer demotion.

Fix: apply the same current actor, machine, workspace and sharing-capability checks to updates as to creation. Fail closed when the recipient is no longer active. Define whether suspension should invalidate existing outbound shares as well as prevent changes.

### F6 — Removed members can delete quarantined workspace machines

Location: `server/relay/pairing-routes.ts:237`.

The legacy `DELETE /api/machines/:machineId` checks platform account status and the retained `owner_user_id`, but not active membership or quarantine. A removed member receives HTTP 200 deleting their quarantined machine registration, although quarantine is documented as holding the machine for administrator transfer or removal. The production handler also revokes its connector credential and drops sockets.

Fix: gate the personal removal route on current workspace membership and the intended machine-management policy. Reserve quarantined-machine deletion for authorized workspace administrators. Keep legitimate local connector disconnection separate from deleting the workspace's registry entry.

## Remediation

| ID | Fix |
| --- | --- |
| F1 | `canonicalizePath` (`server/relay/connector-policy.ts`) refuses any path another parser could read as a different route: literal or percent-encoded dot segments, encoded `/`, `\` or NUL, empty segments, fragments, non-printable characters, and anything WHATWG URL parsing would rewrite. The connector authorizes and then fetches that one canonical URL, with `redirect: 'manual'`. Grantee REST access is now an exact method-and-path list (`GET/HEAD /api/health`, `GET/HEAD /api/sessions/list`, `POST /auth-verify`, `POST /api/upload`) instead of prefixes. |
| F2 | Covered by the exact grantee routes (`/api/sessions/list/` is refused). The response filter additionally keys on the Express-equivalent route identity (case-insensitive, trailing slash ignored), so it fails towards filtering. |
| F3 | `checkServerFrame` in the connector drops, for grantees, any local frame tagged with a session other than the joined one, and machine-wide frames (`webhook_event`). Prompt tracking only records frames that passed, binding approvals to the joined session. |
| F4 | Machine-scoped audit reads and exports require `resolveMachineAccess(...) === 'owner'`: active account, active membership in the machine's workspace, not quarantined, not a viewer. The actor-only endpoint (a user's own actions) is unchanged, as account-level history. |
| F5 | `PATCH /api/shares/:id` re-checks the creator's current authority exactly as creation does (still machine owner, machine not quarantined, `machine.share` in the machine's workspace) and refuses when the grantee is no longer an active member. A demoted creator can still revoke (`DELETE`). |
| F6 | `DELETE /api/machines/:id` requires active membership in the machine's workspace and refuses quarantined machines, leaving those to workspace administrators. |

Relay-side defence in depth: the browser hub applies the grantee REST policy (`checkRestPolicy`) before forwarding a request, and the grants-only outbound frame check (`isServerFrameVisible`) before relaying stream data. A machine still running an older connector is therefore protected against F1–F3 once the hosted relay is updated, though connectors should still be upgraded. Grant-map lookups now use `Object.hasOwn`, so prototype keys such as `toString` are never treated as granted sessions.

Session-tagged frames for another session the grantee *also* holds are dropped by the connector until they join it; the relay-side check, which cannot see joins, allows any granted session.

## Validation

`server/relay/isolation-audit.test.ts` holds the original nine reproductions as ordinary regression tests, plus positive controls (an owner in good standing can still read audit events, widen a share and remove their machine; a demoted creator can still revoke) and unit coverage for path canonicalization, exact grantee routes and outbound frame visibility. Each F-numbered case failed at the audited commit and passes after the fix.

```sh
npx vitest run server/relay/isolation-audit.test.ts
```

Full suite after the fix: **178 files, 3562 tests passing**; server typecheck and ESLint (no errors) clean.

## Controls and limits

The central machine resolver requires an active platform account, active membership in the machine's live workspace, and either machine ownership or explicit session grants. Viewer permissions are capped. Browser channel IDs are remapped per connection, connector responses are tied to the target machine, and revocation paths close active browser sockets with a periodic recheck as backup. The reviewed OAuth, invitation and session lifecycle code includes session regeneration, identity-bound invitations, current-account checks, origin checks, and session expiry/revocation controls.

No arbitrary outsider-to-machine access was demonstrated through the central resolver. That is not a clean bill of health: F4 and F6 explicitly cross the workspace boundary for former members, and F1–F3 violate session isolation for current members with a share.

Two trust assumptions matter:

* Workspace owners/admins may transfer any machine, including to themselves. The new machine owner then has unrestricted session access. This is explicitly allowed by the current matrix, so administrative roles are not a privacy boundary. If admins must be unable to read members' sessions, transfer needs a stronger consent model.
* Session access ultimately reaches a coding process and local OS account. `send_prompt` and approval capabilities are not a filesystem sandbox. A shared coding agent may be able to read unrelated files according to its local tools and permissions. Session isolation at the relay does not establish process-level isolation.

Deployment configuration, currently installed connector versions, historical exploitation, dependency advisories, and cloud/network infrastructure were not verified. Connector fixes require rollout to machines; the relay-side checks cover older connectors for these specific findings, but the outdated-version marker alone should not be treated as enforcement. Production verification of the fixes is still pending deployment.
