# L1 signed intents: code review and security audit

Date: 2026-11-08  
Reviewed baseline: `75c3c38b72e9828f81a8fc552ba80708964eabe3` (merged main)  
Scope: all seven L1 slices, their browser/server integrations, and the L1 requirements in `docs/RELAY-SIGNED-INTENTS-AND-E2E-SPEC.md`.

## Assessment

**Changes required before treating L1's security guarantees as satisfied.** Seven actionable findings remain: three high-priority security defects, three medium-priority security defects, and one medium-priority browser-key correctness defect. One high-priority issue is already acknowledged in the spec; acknowledgement does not restore session binding. Separately, parts of the audit specification remain deferred or absent.

This was a source review with local automated verification, not a live deployment penetration test or an independent multi-reviewer certification. No production service was changed or restarted. No implementation fixes are included in this report. Exploit scripts are not included.

The threat model is the spec's: honest frontend code and local machine, potentially malicious relay backend. Findings do not assume malicious replacement JavaScript or access to private device keys. Low-priority availability issues outside that model were not used to inflate the findings.

## Findings

### F1 — P1 / High: a forged step-up refusal can cause a second execution

**Slice 5, building on slice 4.** Source: [`relay-client.ts:389`](../../../src/lib/transport/relay-client.ts#L389), [`intentSigner.ts:139`](../../../src/hosted/intentSigner.ts#L139).

The REST retry handler trusts an unsigned `intent_step_up_required` response, learns its passkey hints, clears the original nonce, and signs the request again. It does this even for an ordinary request whose locally computed `stepUp` flag is false. In that case the retry still uses the browser key silently. A relay can deliver the first non-idempotent request successfully, suppress its response, and report that refusal. The new signature has a new nonce, so the machine's replay cache does not prevent a second execution of the same user operation.

**Fix:** preserve the operation nonce across all authentication retries, including browser-to-passkey transitions. Since replay entries currently include the signer key ID, bind deduplication to an owner/operation identity that survives that transition, or require a machine-authenticated refusal proving the original attempt was not accepted. Do not initiate step-up retries for actions the browser does not classify as privileged.

**Evidence:** source-confirmed control flow; no additional attack simulation was run for this finding. This differs from the stale-clock retry, which preserves its nonce and verifies a machine signature.

### F2 — P1 / High: revoked or expired shares continue receiving session output

**Slice 6 integration.** Source: [`connector-policy.ts:281`](../../../server/relay/connector-policy.ts#L281), [`connector.ts:41`](../../../server/relay/connector.ts#L41), [`connector-stream.ts:182`](../../../server/relay/connector-stream.ts#L182), [`session-manager.ts:1195`](../../../server/session-manager.ts#L1195).

`liveChannelPolicy` correctly removes revoked/expired grants. However, `checkServerFrame` requires a current grant only for frames carrying a session ID and for specific diff frame types. Ordinary output and thinking frames have no session ID. The existing local socket remains subscribed and those frames continue through even when its effective grant map is empty. An uncooperative relay need not close that channel. This also applies when removing the owner credential invalidates its signed grants.

**Fix:** require a current view grant for the channel's joined session before forwarding any session content, and terminate or detach channels when their authority disappears. Keep any truly connection-wide notices on an explicit content-free allowlist.

**Evidence:** a local reproduction created and verified a signed grant, revoked it on disk, observed an empty effective grant map, and confirmed that an ordinary output frame was still allowed. Existing grant tests check the map change but not the resulting output filtering.

### F3 — P1 / High: a failed session creation leaves signed actions targeting the previous session

**Slice 4 integration; known issue still present.** Source: [`intent-verify.ts:277`](../../../server/relay/intent-verify.ts#L277), [`intent-actions.ts:184`](../../../server/relay/intent-actions.ts#L184), [`ws-message-handler.ts:82`](../../../server/ws-message-handler.ts#L82).

The browser and verifier switch to the synthetic `@created:<seq>` session as soon as a create frame is sent/accepted. If the local server rejects creation, for example because the working directory cannot be resolved, its socket retains the old session mapping. Subsequent signed input, stop, or approval frames can verify against the new-session marker but execute against the old session.

The spec's §6.5 as-built text acknowledges this as a known limit. Its characterization as merely mislabelled honest traffic understates the effect: session binding is an enforcement property. A hostile relay can also conceal the genuine failure because L1 does not authenticate ordinary server replies. This finding does not claim the relay can create a device signature or arbitrarily select a session without the prerequisite channel state.

**Fix:** make session transitions fail closed at the actual execution boundary. Clear the old mapping before attempting creation, and ensure both policy and intent state follow the locally observed result. A failed creation must not leave any later frame able to act on the old session under a new marker.

**Evidence:** a local test used the real verifier and WebSocket message handler. A failed create left the verifier at `@created:1` and the server at `old-session`; a subsequent correctly signed stop was accepted and called `stopSession('old-session')`.

### F4 — P2 / Medium: restart recovery forgets live replay nonces

**Slice 4.** Source: [`intent-log.ts:106`](../../../server/relay/intent-log.ts#L106), [`intent-log.ts:241`](../../../server/relay/intent-log.ts#L241), [`intent-verify.ts:169`](../../../server/relay/intent-verify.ts#L169).

Replay protection survives restart only for accepted intents found in the last 8 MiB of the current log and last 8 MiB of the newest rotation. That byte bound is unrelated to the ten-minute nonce retention window. Fresh accepted nonces can fall outside it before their signatures expire. Rejected frames also contribute to the log; their action labels are derived from unbounded frame type text, so the line-count refusal limit does not bound this displacement.

A connector restart within the freshness window can therefore make a previously accepted REST mutation acceptable again. An attacker still needs a captured valid request and a restart; ordinary reconnects within the same verifier instance do not demonstrate this failure. Log-write failure creates a related durability gap because forwarding does not depend on replay state being persisted.

**Fix:** persist replay state separately with retention based on the validity window, or recover all live accepted nonces and fail closed if recovery is incomplete. Bound logged metadata by bytes as well as entry count. Define the behavior when durable replay recording fails.

**Evidence:** a local reproduction accepted a signed request, generated enough refused traffic to displace its log entry, and confirmed rejection in the original verifier but acceptance in a freshly constructed verifier at the same clock window.

### F5 — P2 / Medium: concurrent flushes can permanently lose pending share revocations

**Slice 6.** Source: [`grants.ts:436`](../../../src/hosted/grants.ts#L436), [`grants.ts:449`](../../../src/hosted/grants.ts#L449), [`grants.ts:470`](../../../src/hosted/grants.ts#L470), [`MachineWorkspace.tsx:38`](../../../src/hosted/MachineWorkspace.tsx#L38).

The pending queue uses separate read/modify/write operations. A flush reads a snapshot, awaits network/signing work, and then replaces the entire stored queue with its own leftovers. Another flush or revocation can add entries while it waits. The older flush can overwrite those additions without ever sending them or receiving machine confirmation. Background maintenance, the share dialog, and other tabs can overlap; the relay can influence the duration of network waits.

A lost entry no longer retries, leaving the old signed grant usable until another independent invalidation or expiry. This is distinct from the relay merely delaying delivery: the browser has lost its durable intent to retry.

**Fix:** use transactionally stored individual queue entries and remove only the exact revision acknowledged by the machine. Coordinate concurrent flushes across tabs; a single in-memory boolean is insufficient. Apply equivalent concurrency discipline to the issued-grant ledger.

**Evidence:** a controlled local interleaving paused an older flush after its read, queued a new unsuccessful revocation, resumed the older flush, and observed the stored queue become empty.

### F6 — P2 / Medium: device removal trusts an unauthenticated acknowledgement

**Slice 5.** Source: [`deviceTrust.ts:485`](../../../src/hosted/deviceTrust.ts#L485), [`enrolment.ts:426`](../../../server/relay/enrolment.ts#L426).

`removeFromMachine` deletes the local pin after any resolved `enrol_revoke` response, without checking the response state or a machine signature. The machine's device-revoke response does not provide such a signature. A relay can withhold the signed revocation and fabricate success, leaving the credential authorized while the UI forgets the pin and reports completion. Other browser contexts holding that key can remain authorized; this does not give the relay the private key.

**Fix:** return a machine-signed, domain-separated acknowledgement bound to the machine, target key and operation nonce. Verify it before declaring removal complete, and retain a pending revocation until confirmation. Handle retries idempotently when the target credential is already absent. For a passkey-only first-use machine pin, distinguish unverified delivery from cryptographically confirmed removal.

**Evidence:** a local test supplied an empty successful reply and observed `deletePin` being called. Share revocations and policy raises already have stronger acknowledgement handling and are useful implementation precedents.

### F7 — P2 / Medium: concurrent first use generates competing browser keys

**Slice 3; browser correctness.** Source: [`deviceTrust.ts:276`](../../../src/hosted/deviceTrust.ts#L276), [`deviceTrust.ts:225`](../../../src/hosted/deviceTrust.ts#L225).

`getOrCreateBrowserKey` reads, generates and writes without an atomic get-or-create operation. Concurrent calls that both observe no key return different key pairs, with the last write becoming the persistent key. Concurrent first-use tabs, registration and enrolment can therefore register or enrol a key that later calls no longer load. A saved machine pin may then name a different key from the browser's persisted key, causing signing to stop and requiring re-enrolment.

**Fix:** choose one persistent winner in an IndexedDB read/write transaction after key generation; return the stored winner to every caller. In-process promise deduplication is useful but does not resolve the cross-tab race.

**Evidence:** two concurrent calls against an initially empty storage adapter returned different key IDs and persisted only one. The production adapter likewise separates the read and write into different transactions.

## Audit-spec completeness

These are documented scope gaps, rather than newly demonstrated signature bypasses:

- §7.1 promises signing-key attribution and device-enrolled, device-revoked and intent-rejected events. `browser-hub.ts` still calls its activity audit helper without the intent, and the event union lacks those three exact lifecycle kinds. The existing enrolment event records a request, not confirmed machine trust.
- Relay activity hashes still use the slice-1 representation. For uploads they hash the body alone; machine intents hash the framed method/path/content-type/body. They are not directly comparable execution records.
- `codekin relay audit verify --against <export>` is not implemented: `devices-cli.ts:186` treats its first argument as a filename. §6.5 explicitly defers this, while §7.2 describes it as available. Reconcile the completion claim and documentation, or implement the correlation path.
- The spec's two-tenant staging gate and manual Safari/Android/desktop/headless checks were not run in this audit.
- The checked-in package is 0.10.5 while the `intents` capability floor is 0.10.6. This is a release prerequisite, not evidence of a signature bypass. The new capability cannot be treated as released merely because the implementation is merged.
- As-built policy enforcement starts on first confirmed owner credential. Before that, new pairings also retain the documented `off` behavior; claims must not imply protection before enrolment.

## Coverage and positive checks

| Slice | Reviewed surfaces and outcome |
| --- | --- |
| 1 — Relay audit | Classification, acknowledgement-based session attribution, REST uploads/creation and metadata. Existing suite passes; cross-log correlation remains incomplete as above. |
| 2 — Identity/trust store | P-256 parsing, public/private matching, pairing lifecycle, file permissions/atomic writes, owner recording, local routes and CLI, trust-store policy. No additional direct relay-to-local-device-route bypass found. |
| 3 — Enrolment | Commitment/reveal, proof of possession, both confirmation codes, machine pin handling, attempt budget, expiry and browser persistence. No new ceremony key-substitution bypass found; F7 affects first-use persistence. |
| 4 — Intents | Payload/action/machine/session binding, nonce/freshness, channel sequence, local execution integration, restart recovery, log, REST proxy and webhook exception. F3 and F4 remain. |
| 5 — Passkeys | WebAuthn origin/RP/challenge/UV checks, domain separation, certification, privileged-action classification, browser fallback/retry and removal. F1 and F6 remain. |
| 6 — Shares | Browser ledger and review, owner signatures, permissions intersection, grantee key binding, expiry/notAfter, superseding, machine revocations and live channels. F2 and F5 remain. |
| 7 — Enforcement | First-device policy raise, remote raise-only behavior, reports and compatibility negotiation, capability floor, workspace grace/refusal, UI status and adversary tests. No new remote policy-lowering path found; prior-slice defects prevent overall sign-off. |

“No additional bypass found” is a bounded review result, not proof of absence. Passkey machine-key first use and grantee key-registry trust limitations already documented by the spec were not relabelled as new vulnerabilities.

## Validation

- `npm test`: **278 files passed; 4,968 tests passed** on the reviewed baseline.
- `npx tsc -b`: **passed**.
- Before switching to source-only review for the remainder of the audit, six isolated local checks confirmed F2–F7. Their assertions described the observed faulty behavior; their passing status is evidence of reproduction, not a security pass. Temporary reproduction files were removed from the source tree and are not included in this PR.
- F1 is supported by source inspection; no dynamic reproduction is claimed.
- No dependency advisory scan, real authenticator/device exercise, live tenant test, deployment or backend restart was performed.

## Recommended sequence

1. Fix F1–F3 before relying on no-replay, session-binding or share-revocation claims.
2. Fix durable replay recovery, queue concurrency, verified removal and atomic key creation (F4–F7).
3. Add regression tests that assert the intended secure behavior, especially at the connector/local-server and browser/storage boundaries rather than only inspecting intermediate maps.
4. Resolve the audit-spec completion gaps, run an independent security re-review on the fixes, and complete the staging/manual gates before release.
