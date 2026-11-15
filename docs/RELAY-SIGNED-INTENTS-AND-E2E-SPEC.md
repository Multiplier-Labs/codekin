# Relay trust: device-signed intents and end-to-end encryption

**Status:** Spec, decisions D1–D16 settled (§13). Built: slice 1 (relay audit events, §7.1), slice 2 (machine identity and trust store), slice 3 (enrolment ceremony, §5.2–5.5), slice 4 (intent signing and verification, §6.1–6.5, §7.2) slice 5 (passkeys: enrolment, `device_certify`, step-up, remote `device_revoke`, §5.4, §5.6, §6.6) slice 6 (signed share grants and grantee intents, §6.7) and slice 7 (enforcement, §6.8): L1 is complete. L2 (slices 8–12) is not built. Revision 3 incorporates the 2026-11-15 spec audit; implementation remains paused until separately authorized.
**Date:** 2026-11-08; L2 sections (§8–§11, §13) revised 2026-11-15
**Context:** §3 records the original pre-L1 trust boundary. Device-signed intents and relay audit events have shipped; **L2 end-to-end content encryption** remains planned. The as-built notes describe current L1 behavior; §8–§11 describe the remaining implementation.
**Basis:** `origin/main` at v0.10.5 (`a93f6e3`). All `path:line` references point there. The L2 sections are based on `origin/main` at v0.12.1 (`04d5e4b`) and name files without line numbers.
**Related:** `docs/HOSTED-RELAY-CONTROL-PLANE-SPEC.md` (§5 trust boundaries, §7 protocol, §14 open questions), `docs/DEVICE-LINK-AND-PASSKEY-SPEC.md`, `docs/HOSTED-SECURITY-AUDIT-2026-09-28.md`.

---

## 1. Summary

Before L1, a connected machine followed the relay's `role: 'owner'` assertion. A compromised relay, insider or operator could drive it. L1 now requires signed intents on protected machines. The relay can still read content in transit until L2 is implemented.

This spec fixes that in two stages.

**L1: signed intents.**
- Each browser the owner uses holds a private signing key that never leaves it.
- The machine keeps its own local list of the public keys allowed to control it.
- A key gets onto that list through confirmation on the machine or certification by an already-enrolled passkey.
- Every frame and request the browser sends to the machine is signed. The connector checks the signature against the local list before anything reaches the local Codekin server.
- Share grants are signed by the owner. Grantees sign their own frames.

With L1 enforced, the relay cannot forge authorized device actions. It can still read, delay or drop traffic, and the initial grantee-key distribution limit in §6.7 remains.

**Audit (built).** The relay records `prompt_sent`, `approval_answered`, `file_uploaded` and `session_stopped`, plus creation and permission-mode events. These records hold metadata, not content (§7.1). The connector keeps its own hash-chained intent log. Comparing it with a relay export is still planned (§7.2, §8.9).

**L2: end-to-end encryption.**
- Each browser↔machine connection runs an authenticated key exchange, using the device keys from L1 and a machine identity key that L1 introduces.
- Every stream frame and REST body is encrypted with AES-256-GCM.
- The relay keeps routing, rate limits and content-free audit metadata. §8.10 lists everything it still sees.
- The user does nothing: no switch, no new ceremony, no recovery key (§8.1).
- Relay-side frame filtering for grantees moves fully to the connector, which already does the same checks.
- This spec uses per-connection keys rather than per-session wrapped keys. The relay stores no content, so there is nothing at rest to wrap keys for (§8.2).

---

## 2. Threat model

### 2.1 Actors

| Actor | Before L1 (L0) | After L1 | After L2 |
| --- | --- | --- | --- |
| Another tenant | Blocked (grantee isolation, `isolation-audit.test.ts`) | Blocked | Blocked |
| A stolen relay session cookie | Full control of the victim's machines | Can't act: no device key. Can still read what the victim's browser is streaming | Cannot decrypt established encrypted content connections without an endpoint key; metadata remains visible |
| Relay backend compromise, or an operator using relay access | Full control of every machine, reads everything | Cannot forge device signatures; initial grantee-key substitution remains possible (§6.7). Reads traffic in transit. Can delay or drop | Cannot decrypt connections to an authentic pinned machine key; metadata, first-use impersonation and grantee-key substitution remain (§8.6) |
| Relay serving malicious web-app JavaScript | Full control | **Not defended.** The JS runs with the user's device key in the user's browser (§2.3) | Not defended |
| Someone with local access to the machine | Full control | Full control (out of scope) | Full control (out of scope) |

### 2.2 Properties L1 must guarantee

The guarantees below assume the machine enforces L1 `required`. Initial identity-distribution limits are explicit in §6.7 and §8.6; they are not cured by transport encryption.

1. **No action without a device key.** The connector forwards no frame or request from the relay to the local server unless it is signed by a key in the machine's local trust store. The only exceptions are `ping` and `resize`, which carry nothing.
2. **The relay can't add keys.** A key enters the trust store only through local confirmation on the machine (§5), or through certification by a passkey that is already enrolled (§5.4).
3. **Bound and fresh.** A signature covers the machine, the session, the action, a hash of the exact bytes that will run, a nonce and a timestamp. A signed intent can't be replayed, sent to another machine or session, or altered.
4. **Grants are the owner's.** A grantee's access is the intersection of what the relay asserts and what the owner signed. A grantee's frames must be signed by one of that grantee's keys listed in the grant.
5. **The relay can't lower the bar.** The machine's intent policy (`off | warn | required`) is local state. Through the relay it can only be raised, by the owner's signed request (§6.8).

**Reads are signed too.** If reads were unsigned, a compromised relay could actively pull data, not just watch: `GET /api/browse-dirs`, `/api/docs` and `/api/repos`, or `join_session` on any session. Signing everything changes the relay's position from "can read anything on the machine" to "can see only what your browser asks for". Signing costs well under a millisecond per frame.

### 2.3 Out of scope, stated plainly

- **Malicious frontend code.** The relay's origin serves the JavaScript that holds the device key. An attacker who can change that bundle can sign anything while the user has the app open. L1 protects against a compromised *backend* or operator API access. It doesn't protect against a compromised *frontend*. Partial mitigations available now:
  - strict CSP and SRI
  - passkey step-up for privileged actions (§6.6), which shows an operating-system prompt the page can't hide

  The full answer is L3 (§12): a reproducible, signed frontend build, and the desktop app loading a bundled copy.
- **Denial of service.** A relay can always refuse to carry traffic.
- **Traffic analysis** (sizes and timing) after L2.
- **Local compromise** of the machine or of the browser profile.

### 2.4 What each level lets an operator claim

- **L1:** "The relay can't run anything on your computer. Only devices you approved on that computer can." Add a pointer to §2.3. Don't claim confidentiality.
- **Until L2:** an operator can say that the relay processes session content in memory and in transit only, and doesn't store it. That is true today: `server/relay/audit.ts:1-7` persists metadata only.
- **L2:** "Session content is end-to-end encrypted on encrypted browser-to-computer connections." Publish with the identity status and limitations of §8.12; do not imply that first-use keys were independently verified.

---

## 3. Original baseline (before L1)

These observations are historical, from `a93f6e3`; they explain the original design. Current enforcement is documented in the as-built sections. The full content-inspection inventory relevant to L2 is in §8.11.

- The relay attaches a `RelayPrincipal { userId, role, grants }` to everything it forwards (`server/relay/relay-protocol.ts:76-87`, `browser-hub.ts:106`).
- The connector takes the relay's word for the role: `connector-proxy.ts:112` and `connector.ts:252`. Every policy function short-circuits for owners (`connector-policy.ts:181, 282, 307, 347`). The file header says so: "Owners bypass these checks" (`connector-policy.ts:10`).
- Grants arrive in the same relay-built principal. The connector re-checks frames *against grants the relay supplied*. That stops a buggy relay. It doesn't stop a malicious one.
- Stream frames pass through as opaque strings (`StreamData.data`, `relay-protocol.ts:139-142`). The hub forwards only `payload.data` (`browser-hub.ts:444`). The connector receives them at `connector.ts:147`.
- The relay inspects content in two places only:
  - `isServerFrameVisible` on grantee streams (`browser-hub.ts:422-425`)
  - `checkRestPolicy` on grantee REST paths (`browser-hub.ts:352`)

  Both duplicate connector-side checks (`connector-policy.ts:262, 281`), kept for older connectors.
- The hub never starts requests of its own. Every `sendRequest` comes from a browser (`browser-hub.ts:367`). The connector's one internal owner-principal call (`connector.ts:223`) doesn't arrive from the relay.
- Local-only routes are already beyond the relay's reach: pairing (`pairing-local-routes.ts`). `/api/relay/*` is in neither proxy allowlist (`connector-proxy.ts:28-83`).
- The relay already has WebAuthn passkeys, with rpID = relay hostname (`webauthn-routes.ts:120`), `@simplewebauthn/server` in `server/package.json` and the browser package at the root.
- The audit kinds `prompt_sent`, `file_uploaded`, `approval_answered` and `session_stopped` are declared (`audit.ts:21-24`) and never emitted. Stream activity records only `session_viewed` (`browser-hub.ts:399`).
- Connector version is a warning only (`connector-version.ts:12`, `MIN_SUPPORTED_CONNECTOR_VERSION = '0.9.0'`).

---

## 4. Keys

All cryptography uses primitives that both WebCrypto, in every browser we support including WKWebView in the desktop app, and Node `crypto` provide without dependencies:
- ECDSA P-256 with SHA-256 for signatures (IEEE P1363 `r||s` encoding, WebCrypto's native output; Node verifies with `dsaEncoding: 'ieee-p1363'`)
- ECDH P-256 and HKDF-SHA-256 for L2 key agreement
- AES-256-GCM for L2 encryption

X25519/Ed25519 are deliberately avoided: WebCrypto support for them is still uneven across Safari versions.

### 4.1 Machine identity key

- **When:** generated by the connector at pairing time, or on first start after upgrade for already-paired machines.
- **What:** one ECDSA P-256 key pair for signing. L2 adds no long-lived key: its ECDH keys are made per connection (§8.3).
- **Where:** `~/.config/codekin/relay-identity.json`, mode 0600, beside `relay.json`. The desktop app moves it into the macOS Keychain, the same as the planned move for the machine secret.
- **What it's for:**
  - The connector signs enrolment transcripts (§5.2), so the browser can tell it is talking to the real machine.
  - It authenticates the machine's side of the L2 handshake.
- **Registry:** the public key is sent to the relay on `pair/complete` and in `ConnectorHello`, so browsers can fetch it. The relay copy is only a hint. Browsers use their own persistent pin, with its provenance: locally confirmed enrolment or explicitly identified first use (§8.6). Registry updates never replace that pin.
- **Lifecycle:** re-pairing creates a new identity. Every device has to enrol again, and the UI says so.

### 4.2 Device credentials

The trust store accepts two kinds of owner credential.

| Kind | Material | Signs | Survives | Use |
| --- | --- | --- | --- | --- |
| **Browser key** | WebCrypto ECDSA P-256, `extractable: false`, stored as a `CryptoKey` in IndexedDB under the relay origin | Silently, every frame | Until site data is cleared, or Safari's 7-day eviction for sites not added to the home screen | Day-to-day signing |
| **Passkey** | An existing relay WebAuthn credential (public key, credential id, rpID) | One assertion per action, with user presence and verification | Synced by the passkey provider | Enrolling new browsers without the machine (§5.4); step-up for privileged actions (§6.6) |

- **One browser key per browser profile per user**, shared across all that user's machines. Each machine enrols it separately.
- **Key id:** `base64url(SHA-256(SPKI))[0:22]`.
- **Relay registry:** the relay keeps a `device_keys` table (`user_id, key_id, spki, label, created_at, last_seen_at, revoked_at`). It feeds the UI and supplies grantee key sets (§6.7). It isn't trusted.

**Storage exception.** The settings move away from browser storage (#670, #671) was about preferences that should follow the user. A signing key is the opposite case: it must *never* follow the user, and storing it server-side would defeat its purpose. IndexedDB is the right place, and is the only browser storage this feature uses. The code comment and `docs/` should say so, so nobody later "fixes" it.

**Desktop web mode.** Passkeys don't work in the desktop app's WKWebView without an associated-domains entitlement, which we don't have. When the hosted UI runs there, it uses browser keys only. Adding a browser through local confirmation still works (§5).

### 4.3 The trust store

**File:** `~/.config/codekin/relay-devices.json`, mode 0600. Only the connector and local routes ever write it.

```json
{
  "version": 1,
  "machineId": "m_…",
  "ownerUserId": "u_…",
  "relayOrigin": "https://relay.example.com",
  "policy": "required",
  "credentials": [
    {
      "keyId": "q3…",
      "kind": "browser",
      "userId": "u_…",
      "spki": "base64url…",
      "label": "Safari · iPhone",
      "addedAt": "2026-11-08T10:00:00Z",
      "addedBy": "local",
      "lastUsedAt": "2026-11-08T12:31:00Z"
    },
    {
      "keyId": "p7…",
      "kind": "passkey",
      "userId": "u_…",
      "credentialId": "base64url…",
      "cosePublicKey": "base64url…",
      "rpId": "relay.example.com",
      "label": "iCloud Keychain",
      "addedAt": "…",
      "addedBy": "local"
    }
  ],
  "pending": [],
  "revokedGrants": []
}
```

- `addedBy` is either `local`, meaning confirmed on the machine, or `passkey:<keyId>`, meaning certified by an enrolled passkey. Certified keys can't certify further keys.
- `ownerUserId` is recorded at pairing. It comes from `pair/complete`, which needs to return the owner's user id as well as `ownerLogin`. A frame signed by an owner credential must also carry a relay principal with the same `userId`. Signatures prove the device; the principal match catches confusion between accounts.
- The standalone CLI connector (`codekin relay connect`) and `codekin relay devices …` share the file. The connector watches it for changes, the same way the embedded connector already picks up `relay.json`.

---

## 5. Enrolment: putting a key on the machine

### 5.1 Requirement

Adding a credential needs either local confirmation on the machine, or an assertion from a passkey that is already enrolled. Nothing the relay can do on its own produces either. The protocol also has to stop the relay from **swapping keys in transit**. The browser and the machine each see the other's public key only through the relay, so we compare a short code derived from both keys. To stop the relay from grinding keys offline until the codes match, the browser **commits** to its key before it learns the machine's nonce.

### 5.2 Ceremony

Messages travel over new relay envelope kinds, handled by the connector itself rather than proxied to the local server:
- browser → hub → connector: `enrol_commit`, `enrol_reveal`
- connector → hub → browser: `enrol_challenge`, `enrol_result`

```
Browser B (owner, signed in)                Relay              Connector M
1. kB (browser key), passkeys P[] to add,
   label, nonceB ← 32 random bytes
   C = SHA-256("ck-enrol-commit-v1" ‖ SPKI(kB) ‖ P[] ‖ label ‖ nonceB)
   ──── enrol_commit { C } ─────────────────────────────────────►
                                     store pending { enrolId, C, userId, expires: 10 min }
                                     (≤ 3 pending per machine)
   ◄─── enrol_challenge { enrolId, SPKI(kM), nonceM,
                          sigM over (enrolId ‖ C ‖ nonceM) } ────
2. verify sigM with kM. kM is pinned only if step 4 succeeds.
   ──── enrol_reveal { enrolId, SPKI(kB), P[], label, nonceB,
                       popB = sig_kB(enrolId ‖ nonceM) } ────────►
                                     check C matches, check popB
3. Both sides compute
   SAS = base32(SHA-256("ck-sas-v1" ‖ SPKI(kM) ‖ SPKI(kB) ‖ P[] ‖ nonceB ‖ nonceM))[0:8]
   and show it as "K7QM-2XPA" (40 bits).
4. The user types the code shown in the browser into the machine:
   local Settings, the desktop app, or `codekin relay devices approve K7QM-2XPA`.
                                     match against pending entries → add kB and P[] to the trust store
   ◄─── enrol_result { ok, sigM(trust-store digest) } ───────────
5. The machine then shows a 6-character finishing code
   CC = base32(SHA-256("ck-enrol-confirm-v1" ‖ SPKI(kM) ‖ SPKI(kB) ‖ P[] ‖ nonceB ‖ nonceM))[0:6].
   The user types it into the browser; B computes CC from its own view and,
   only if they match, pins kM for this machine in IndexedDB.
```

**Why this design.**
- **The user types the code; they don't compare two codes.** People click "they match" without looking. Typing the code is no slower and actually checks it.
- **The finishing code protects the browser's pin.** Without step 5, a relay could answer a browser's *first* enrolment as the machine: sign the challenge and the `enrol_result` with a key of its own, which the browser has no pin to check against. The machine is safe either way, because the code the browser shows is computed with the relay's key and won't match. But the browser would pin the relay's key, and L2 (§8.6) trusts that pin. The machine shows CC only after it accepted the code, so a relay that swapped `kM` never gets one shown to the user. Decided 2026-11-08 (option A on #818).
- **A swapped key fails.** If the relay replaces `kB`, the commitment fails, or the machine computes a different code from the one the browser shows. The relay committed before seeing `nonceM`, so it can't grind for a match. The chance of a guess landing is 2⁻⁴⁰ per pending request, with at most 3 pending.
- **Passkeys are in the transcript.** That stops the relay from adding a passkey public key of its own alongside a real browser key.
- **Proof of possession.** `popB` ties the reveal to a key the browser actually holds.

**As built (slice 3).** Where the implementation pins down what the diagram leaves open:
- **Encoding.** Every hashed or signed message is a transcript: a domain label, then each field as a 4-byte big-endian length followed by its bytes. `P` is UTF-8 JSON of `[credentialId, cosePublicKey, rpId]` triples, `[]` until passkeys join (slice 5). The labels are `ck-enrol-commit-v1`, `ck-enrol-challenge-v1`, `ck-enrol-pop-v1`, `ck-sas-v1` and `ck-enrol-result-v1`. Code: `server/relay/enrolment-crypto.ts`, mirrored in `src/hosted/deviceTrust.ts`, with a shared test vector.
- **Waiting for the code.** The browser polls with a fifth frame, `enrol_status { enrolId }`, answered by `enrol_result`. This survives a locked phone or a reconnect, and an unsolicited push would not.
- **The result signature.** `enrol_result` for an approval or refusal carries `sign_kM(T(result, enrolId, SPKI(kB), outcome))`, signing the decision about this key rather than a trust-store digest. A valid signature moves the browser on to the finishing code, but it never pins anything by itself: on a first enrolment a relay could sign it with its own key.
- **The finishing code.** CC is shown by Settings → Remote access after Confirm, printed by `codekin relay devices approve` and the login prompt, and listed by `codekin relay devices list` for an hour after approval.
- **Where requests wait.** Requests live in `relay-devices.json` → `pending`, under a lock file, so the local UI and CLI can decide them from another process.
  - At most 3 requests wait undecided. A fourth replaces the oldest, so an owner who reopens the sheet isn't locked out.
  - A machine accepts at most 20 requests per 10 minutes, failed ones included. Each request gives a relay one 2⁻⁴⁰ guess at a code, so this bounds the guesses however fast it retries.
  - Requests expire after 10 minutes. A decision stays collectable for 24 hours.
- **Refusals.** A reveal that fails its commitment or proof-of-possession check uses up the request, which keeps counting against the budget. Only the owner can enrol: the hub refuses grantees, and the connector compares the principal with the `ownerUserId` it recorded at pairing.
- **The code is authentic, not secret.** Every input to the code crosses the relay, so a relay can compute it. That doesn't matter as long as it can't enter it: only local surfaces (Settings on the machine, `codekin relay devices approve`, the login prompt) accept a code. The local list of waiting requests still never shows it, because the owner has to read it off the browser. **For slices 4 and 7:** a relay that can drive a session on the machine could have it run `codekin relay devices approve` or edit `relay-devices.json`. Signed intents must close that before enforcement means anything.
- **The browser's first pin** is covered by step 5 (above).
- **Old connectors.** A connector that can enrol advertises the `enrolment` feature. The hub answers older ones with `connector_update_required` straight away.
- **Registry.** When a machine accepts a reveal, the relay records the key in `device_keys` (`POST /api/device-keys`).
- **Not built yet:** the desktop notification and tray item for a waiting request (§5.5), and the Account → Devices page (§6.9).

### 5.2b One pasted command instead of two codes (trust token)

Typing a code on the machine and another back in the browser is the slowest part of the ceremony, and on a headless machine it means a terminal anyway. A trust token turns it into one paste that goes browser → machine, with nothing to type back.

1. The browser makes a 16-byte secret `S` and shows `codekin relay devices trust <base64url(S)>`. `S` never crosses the relay: the only copy outside the browser is the one the owner pastes on the machine.
2. The §5.2 ceremony runs as before. If the machine's `enrol_challenge` says `trustTokens: true`, the reveal also carries `trust { id, mac }`:
   - `id = base64url(SHA-256(T("ck-trust-id-v1", S)))[0:16]`
   - `mac = HMAC_S(T("ck-trust-reveal-v1", enrolId, SPKI(kM), SPKI(kB), P, label, nonceB, nonceM))`
3. The owner pastes the command on the machine: in a terminal, into the code field of local Settings, or at the `codekin relay login` prompt. The machine finds the request by `id`, checks `mac` with `S` and its own key, and adds `kB` (and `P`) exactly as a typed code would.
4. `enrol_result` for that approval carries `trustMac = HMAC_S(T("ck-trust-result-v1", enrolId, SPKI(kM), SPKI(kB), P))`. The browser checks it and pins `kM` with nothing typed.

**Why it holds.**
- The relay never sees `S`, so it can't produce `mac` for a key of its own.
- `mac` covers the machine key the browser was shown, so a relay that swapped `kM` towards the browser fails the check on the real machine.
- `trustMac` can only come from something that holds `S`, so it pins `kM` as safely as the finishing code does.
- 128 bits of `S` leave nothing to grind. A request whose `mac` fails is spent, like a failed reveal.
- The usual limits still apply: owner only, 3 waiting requests, 20 per 10 minutes.
- It holds only while `S` stays off the relay's data plane. A Codekin session's input and output can cross the relay, so `S` (like the codes) must never be given to one: anyone who reads `S` can have their own key approved. The sheet points to a terminal or SSH only, and `codekin relay devices trust|approve` refuse to run inside a Codekin session (`CODEKIN_SESSION_ID` set). That refusal is a guard against the easy path, not a boundary: a process can clear its environment.

**Pasted before the browser asks.** The hosted install command carries `CODEKIN_TRUST_TOKEN=<S>` next to the pairing token, so the install pastes the token before the machine is even online. The machine then keeps `{ id, S }` in `relay-devices.json` → `trustTokens` (0600) for 30 minutes, at most 3 at a time. The first request offering that `id` with a valid `mac` is approved at once and the token is spent. When the machine comes online, the browser that generated the command runs the ceremony with `S` and is confirmed without a prompt (§5.3).

**Compatibility.** An older connector doesn't say `trustTokens`, and an older relay strips the field. Either way the browser shows the two codes instead. Approvals record `addedBy: 'local'`, since the command was pasted on the machine.

### 5.3 At pairing

Pairing already has the user at the machine and in the browser at the same moment.
1. Approving the pairing code in the browser starts the ceremony straight away.
2. The CLI or local UI that showed the pairing code then asks: "Type the code your browser shows to let it control this machine."
3. New pairings set `policy: "required"` once the first credential is enrolled.

The two steps finish together: the user types one code on the machine, and the machine is paired and trusts that browser.

**As built (one-line install).** The command generated in the hosted app carries a trust token (§5.2b) as well as the pairing token. The installer, or `codekin relay login`, keeps it on the machine, and the browser tab that generated the command confirms itself once the machine is online. Nothing is typed. Without a token, `codekin relay login` asks for the browser's code, or accepts its pasted command.

### 5.4 Adding a browser later

- **With an enrolled passkey (common case, no trip to the machine).**
  1. The new browser generates `kB` and asks for one passkey assertion. Its challenge is `SHA-256(intent)`, where `intent` is a `device_certify` intent naming `SPKI(kB)` and its label.
  2. The connector verifies the assertion the way any WebAuthn verifier does (§6.4, step 3).
  3. It adds `kB` with `addedBy: passkey:<id>`.

  The new device is only as trusted as the user's passkey provider (iCloud Keychain, Google Password Manager, 1Password). That is a deliberate trade (D5 in §13), with these limits:
  - The assertion must carry the user-verification flag.
  - The machine's device list shows the browser as "added by passkey" with the time. The owner's other enrolled browsers are told about it.
  - A machine-local setting, **"Only allow devices confirmed on this computer"** (default off), turns passkey certification off for owners who don't trust their passkey provider's sync. Like `policy`, only local surfaces can change it.
- **Without one.** Run the §5.2 ceremony and confirm on the machine.
- **New passkeys** can only be added through §5.2. A passkey can't add another passkey.

### 5.5 Where local confirmation happens

| Surface | Route | Why the relay can't reach it |
| --- | --- | --- |
| Local web UI: Settings → Remote access → "Devices that can control this computer" (pending requests, code entry, list, revoke) | `GET/POST/DELETE /api/relay/devices*` on the local server, local auth token | `/api/relay` is in neither proxy allowlist (`connector-proxy.ts:28-83`). A test pins this |
| Desktop app | Same local UI. A notification and the tray item open it while a request is pending | Local |
| CLI | `codekin relay devices list \| trust <token> \| approve <code> \| revoke <keyId> \| policy <off\|warn\|required>` | Edits the trust store file directly |

Headless servers use the CLI over SSH, or a local UI that is already exposed behind its own authentication. That is the local trust boundary, not the relay's.

### 5.6 Revocation and recovery

- **Revoke locally.** Use any surface in §5.5. This is the authoritative path.
- **Revoke remotely.** Send a `device_revoke` intent signed by an enrolled owner credential, with passkey step-up when required. The browser keeps its machine pin, marked removal-pending, until it verifies `sign_kM(T("ck-device-revoked-v1", machineId, keyId, requestNonce))`. An unsigned reply cannot confirm removal. If the acknowledgement is lost after self-revocation, another attempt can obtain a fresh signed proof that the key is absent. A machine key learned only through passkey enrolment must first be confirmed with the codes, or removal must happen locally.
- **Signing out everywhere** (`/api/auth/logout-all`) leaves device keys in place, because they are machine trust, not relay sessions. The account security page offers "Also remove this browser from all my computers", which sends signed `device_revoke` intents.
- **Lost every device.** Enrol again through the §5.2 ceremony on the machine. Being able to recover only from the machine is the point of the design.
- **Machine reinstalled or re-paired.** It gets a new identity key and an empty trust store. Browsers drop the old pin when the relay reports a new machine id.

---

## 6. Signed intents (L1)

### 6.1 Format

The browser builds the intent as a JSON **string** and signs exactly those bytes. Signing the string means neither side has to canonicalise JSON. The verifier checks the signature first and parses the string afterwards.

```ts
interface IntentBody {
  v: 1
  machineId: string
  /** Session the action targets; null for machine-level actions (create session, list, browse). */
  sessionId: string | null
  /** 'ws:<frame type>' | 'rest:<METHOD> <pathname>' | 'channel:open' | 'grant' | 'device_certify' | ... */
  action: string
  /** base64url SHA-256 of the exact bytes that will run (below). */
  payloadHash: string
  /** 16 random bytes, base64url. */
  nonce: string
  /** Browser clock, ms since epoch. */
  ts: number
  /** Signing credential. */
  keyId: string
}

interface SignedIntent {
  body: string           // JSON.stringify(IntentBody)
  sig?: string           // browser key: base64url P1363 ECDSA over UTF-8(body)
  webauthn?: {           // passkey: assertion whose challenge = SHA-256(UTF-8(body))
    authenticatorData: string
    clientDataJSON: string
    signature: string
  }
}
```

**`payloadHash` input:**
- Stream frame: the UTF-8 bytes of `StreamData.data`, exactly as the connector will send it to the local socket.
- REST request: `UTF-8(METHOD "\n" path-with-query "\n" (contentType ?? "") "\n") ‖ bodyBytes`. The path must already pass `canonicalizePath`, so the authorized path, the signed path and the executed path are the same string.
- Channel open: the empty string.

### 6.2 What is signed

**Everything from browser to machine**, except `ping` and `resize`:
- every `ProxyRequest` (reads too, §2.2)
- every `StreamOpen`
- every client stream frame

The shared module `server/relay/intent-actions.ts` (imported by browser and connector) maps actions to two attributes:
- the **audit kind** (§7)
- whether the action needs **step-up** (§6.6)

A frame type that isn't in the map needs a signature and has no audit kind. It fails closed, the same as the default branch of `checkClientFrame`.

| Action | Audit kind | Step-up |
| --- | --- | --- |
| `ws:input`, `ws:review_feedback_send` | `prompt_sent` | — |
| `ws:prompt_response` | `approval_answered` | answers of `always_allow` / `approve_pattern` |
| `ws:stop` | `session_stopped` | — |
| `rest:POST /api/upload` | `file_uploaded` | — |
| `ws:create_session`, `rest:POST /api/sessions/create` | `session_created` (new) | with pre-approved tools (`allowedTools`); in `bypassPermissions` only on a machine with `passkey-for-bypass on` |
| `ws:set_permission_mode` | `permission_mode_changed` (new) | to `bypassPermissions`, only on a machine with `passkey-for-bypass on` |
| `rest:POST /api/orchestrator/trust/pin\|approve`; any create or change (POST, PUT, PATCH) under `/api/orchestrator/automations`, `/api/orchestrator/maintenance`, `/api/workflows/schedules`, `/api/workflows/config`, `/api/deployments`, `/api/integrations/github/pr-review` | — | always: standing authority (§6.6). Exempt: one-off runs and checks, stopping and removing (`STANDING_EXEMPT` in `intent-actions.ts`), and the PR-review setup's `dryRun: true` preview. DELETE never counts |
| `grant`, `grant_revoke` | `session_shared` / `session_unshared` | grants that include `approve_shell` |
| `device_certify`, `device_revoke` | `device_enrolled` / `device_revoked` (new) | always (`device_certify` *is* a passkey assertion) |
| `device_policy` (raise only, §6.8) | `machine_policy_changed` (relay, from the connector's report) | never: raising is the safe direction |
| reads (`rest:GET …`, `ws:join_session`, `ws:get_diff`, …), `channel:open` | — (covered by `session_viewed`) | — |

### 6.3 Wire changes

All fields are optional. Old peers ignore them. `RELAY_PROTOCOL_VERSION` stays at 1, and new behaviour is negotiated through capabilities.

```ts
interface ProxyRequest { /* … */ intent?: SignedIntent }
interface StreamOpen   { /* … */ intent?: SignedIntent }
interface StreamData   { data: string; intent?: SignedIntent }
interface RelayPrincipal { /* … */ signedGrants?: SignedIntent[] }   // §6.7

interface ConnectorHello {
  /* … */
  capabilities: { /* … */ features?: Array<'intents' | 'e2e' | 'credentialClass'> }
  identityKey?: string        // SPKI, §4.1
  intentPolicy?: 'off' | 'warn' | 'required'
}
```

**Hub:**
- Forward `intent` along with `data`. `browser-hub.ts:444` and `connector-hub.ts:279` currently pass `data` only.
- Route the `enrol_*` kinds.
- Record `intentPolicy` on the machine row so the UI can say whether a browser needs to be trusted.

**Browser:**
- `RelayConnection.sendOrQueue` (`src/lib/transport/relay-client.ts:294`) and the REST path in `src/lib/transport/hosted.ts` sign before sending whenever the machine advertises `intents`.
- Signing is async (WebCrypto), so each channel keeps a per-channel send queue to preserve frame order.

### 6.4 Verification on the connector

Verification sits at the relay message boundary in `connector.ts`: `request`, `stream_open` and `stream_data`, around lines 143–148. It runs before `executeProxyRequest` and `StreamChannel.send`. Internal calls such as `localSessionSummary` (`connector.ts:223`) never pass through it. In `required` mode, the connector does the following for each message:

1. **Exemptions.** `ping` and `resize` frames pass. Any other message without `intent` is refused with `intent_required`.
2. **Find the key.** Look up `keyId` in the trust store. If it is missing, refuse with `intent_unknown_key`. Then check the signer: an owner credential needs `principal.userId === ownerUserId`, and a grantee key needs `principal.userId` to match the grant (§6.7).
3. **Check the signature.**
   - Browser key: ECDSA P-256/SHA-256 over `UTF-8(body)`.
   - Passkey: use `verifyAuthenticationResponse` from `@simplewebauthn/server`. The expected challenge is `SHA-256(body)`, the expected origin is `relayOrigin` from the trust store, and the expected RP ID is the passkey's `rpId`. User presence and user verification are required. The counter is ignored, because synced passkeys report 0.
4. **Parse the body.** Then check:
   - `v === 1` and `machineId === this machine`
   - `action` matches the message: frame type, or method plus canonical path
   - `payloadHash` matches a hash recomputed from the bytes that will actually be forwarded
5. **Session binding.**
   - Session-scoped stream frames: `sessionId` must equal the session the channel has joined (`ChannelState.sessionId`), or the frame's own `sessionId` field.
   - `ws:join_session`: `sessionId` must equal the session being joined.
   - REST paths with a session id: `sessionId` must equal it.
6. **Freshness.** `|ts − now| ≤ 5 min` (otherwise `intent_stale`). `(machineId, userId, nonce)` must not already be in the replay store. The store holds entries for 10 minutes, shared across all of an account’s credentials on that machine. Only real devices create valid entries, so it stays small; cap it at 50k entries anyway.
7. **Step-up.** If the action needs step-up (§6.2) and the signer has an enrolled passkey on this machine, the intent must be passkey-signed. Otherwise refuse with `intent_step_up_required`.
8. **Hand on.** Pass the request or frame to the existing policy (`checkRestPolicy`, `checkClientFrame`). The "owner bypass" in those functions now means "verified owner" rather than "relay said owner". Append the outcome to the local intent log (§7.2).

**Refusals** use the existing `error` envelope with code `not_permitted`, a new `detail` field (one of the `intent_*` reasons above) and `intentNonce`. That lets the browser match the refusal to what it sent, and lets the relay audit it.

**`warn` mode** runs the same checks, logs failures and forwards anyway. It exists only for migration.

### 6.5 Clocks

- If the browser's clock is out, the connector refuses with `intent_stale` and includes `machineTime`.
- The browser may apply an offset of up to ±1 h and retry once.
- The offset is advice the relay could alter. The worst case is a delayed delivery: the relay holds a future-dated intent until it falls inside the window. Holding a message is already something a relay can do, and the nonce still limits it to one delivery.

### 6.5a As built (slice 4)

- **Shared rules.** `server/relay/intent-actions.ts` has no Node or DOM imports, and the browser imports it directly. It defines action names, payload bytes, exemptions and session binding, so both ends compute them from one source.
- **When the browser signs.** A browser signs only for a machine it has pinned (§5.2), and sends unsigned everywhere else, so no capability negotiation is needed. Connectors advertise `intents`; slice 7 set its version floor (§6.8a).
- **Policy modes.**
  - `off`: signed messages are verified and logged, and everything is forwarded.
  - `warn`: also logs unsigned messages.
  - `required`: forwards only messages that verify.

  Until slice 5, passkey-signed intents are refused as `intent_unsupported`. Until slice 6, grantees can't sign, so a `required` machine refuses them.
- **Exempt.** `ping`, `resize` and `auth` need no intent, and none of them reaches the local server:
  - the connector answers `ping` with `pong` itself;
  - it drops `resize`, which does nothing locally anyway;
  - it answers `auth` from its cached handshake.

  So a relay can't spend the local socket's message budget with them. GitHub webhook deliveries are also exempt, because GitHub's HMAC authenticates them.
- **Local message budget.** The local server silently drops anything past 60 messages a second. The connector forwards at most 50 a second on any sliding window and refuses the rest with `intent_rate_limited`, before verification. A frame can then never be accepted, advance the session tracking, and be dropped downstream.
- **Channel and order.** The intent body gains two optional fields for streams: `channel` and `seq`.
  - The signed `channel:open` carries a random channel token. Every frame carries that token and a `seq` that starts at 1 on each channel.
  - The connector accepts only frames whose `seq` is higher than the last one it accepted. A relay can drop frames, but it can't reorder them (`intent_out_of_order`) or move them to another channel (`intent_wrong_channel`).
- **Session binding.** A frame's own `sessionId` wins. Otherwise the binding is the channel's session, tracked from client frames only:
  - `join_session` sets it.
  - `leave_session` clears it.
  - `create_session` moves it to `@created:<seq of that frame>`, because the local server joins the socket to the new session, whose id neither end knows yet.

  REST paths name a session as `/api/sessions/<id>[/…]` or `/api/sessions/archived/<id>`.
- **REST payload.** The four fields (method, path with query, content type, body) are each length-prefixed, so none can run into the next.
- **Ordering in the browser.** The browser signs asynchronously, but fixes each frame's session and `seq` when it is sent, and sends frames through a per-channel queue. Closing a channel lets frames still being signed go out first.
- **Clocks.**
  - The browser hub's `hello_ack` carries the relay's `serverTime` as a first offset, used only until the machine has given its own time.
  - An `intent_stale` refusal carries `machineTime` with `machineTimeSig = sign_kM(T("ck-intent-time-v1", nonce, machineTime))`. The browser adopts the time only if that verifies against its pinned machine key, so a relay can neither shift the clock nor trigger a retry.
  - A REST request refused as genuinely stale is retried once with the **same nonce**, using exactly the authenticated machine time for that nonce. Retries are only started within 60 seconds of the original call. A step-up retry is allowed only for a locally classified privileged action and preserves both the original nonce and timestamp, even when it changes signing credentials. An operation that already ran is refused as a replay.
  - A stale stream frame closes its channel, and the corrected offset applies to the next channel.
- **Durable replay protection.**
  - Entries last 10 minutes (twice the skew window), keyed by machine, account and nonce. Browser-key and passkey retries share the same entry.
  - The SQLite file beside the device list (`relay-devices.json.replay.sqlite`, mode 0600) commits each accepted nonce with full synchronization before forwarding. Independent connectors serialize consumption in a transaction. Audit rotation, unavailable logs and process restarts cannot discard live entries.
  - An existing installation without this database refuses signed actions for a one-time 10-minute recovery window; the deadline survives restarts. New local pairing initializes an empty database without the delay; reusing a machine id does not prove that its replay history is empty. Corrupt or unavailable storage refuses with `intent_replay_unavailable`.
  - At 50k entries per machine it refuses (`intent_rate_limited`) rather than evicting a live entry.
- **Device list handling.** An unreadable device list fails closed, treated as `required`. A device's `lastUsedAt` is written back at most every 10 minutes, off the request path.
- **Log.** `~/.codekin/relay/intents.jsonl` adds a `forwarded` field to each line.
  - Unsigned messages are logged only in `warn` and `required`. The full intent is stored only for accepted ones.
  - Refusal lines are capped at 120 a minute, and the next line records how many were dropped (`suppressedBefore`).
  - 12 rotated files are kept. A torn last line is closed off before the next append.
  - Reads come from the tail.
  - The local view is Settings → Remote access → Activity, and on the command line `codekin relay audit [list | verify]`.
- **Webhook replay (connector).** Forwarded GitHub deliveries are deduplicated on the SHA-256 of the body GitHub signs, not on the unsigned delivery id. Undated events are never aged out. GitHub's "Redeliver" therefore does nothing for a delivery that already succeeded.
- **Failed session creation.** Before attempting `create_session`, the local server leaves the old session and clears the socket’s session binding. If creation fails, later input and stop frames have no old session to act on; the browser must join or create a session again.
- **Deferred.**
  - `--against <relay export>`: relay audit events don't carry `keyId` or nonces yet.
  - The §6.2 audit-kind and step-up map: slice 5.
- **The relay-driven-session gap from §5.2.** A machine set to `required` closes it: a relay can no longer inject frames into a session to run `codekin relay devices approve`.

### 6.6 Step-up with a passkey

**Privileged actions** are listed in §6.2: saving standing approval rules and pre-approved tools, shell-approving grants, standing automation, and device changes. Bypass permission mode is privileged only on a machine whose owner turned on `codekin relay devices passkey-for-bypass on` (`relay-devices.json` → `passkeyForBypass`). By default a confirmed device may start or switch to bypass: prompts sent to a bypass session have never needed a passkey, so asking for one when it starts added friction (often tens of sessions a day) without stopping a page that holds the browser key. A browser learns that a machine is strict from its first step-up refusal of a bypass action, and asks for the passkey there from then on. Standing authority set over REST is privileged whatever its body: trusting the orchestrator (`POST /api/orchestrator/trust/pin|approve`), and creating or changing anything under the automation prefixes in §6.2 (automations, maintenance plans, schedules, review config, monitored deployments, the PR-review webhook). Those prefixes are privileged by default: a new route under them needs a passkey until it is added to `STANDING_EXEMPT`, which lists only one-off runs, checks, and stopping or removing. A test walks the routers the local server registers and fails if that list changes unreviewed.

The step-up guards standing authority and makes privileged actions visible; it is not a boundary around the shell. A page holding a confirmed browser key can still send a prompt and answer the resulting approval with a plain "allow" (not privileged), so `passkey-for-bypass on` removes one easy path to unprompted commands, not every path. One-off unattended runs (`POST /api/orchestrator/children` with its default tools, workflow and loop runs) are not privileged for the same reason. If the owner has a passkey enrolled on the machine, these need a passkey assertion. The OS prompt ("Use Face ID to approve: Share session 'api-fix' with Dana, shell approvals") is the one thing a compromised page can't fake. The prompt text comes from the intent, so the connector sees the same action the user approved.

If the owner has no enrolled passkey, the browser key is accepted (D2 in §13). A passkey can't be required everywhere, because the desktop app's web view can't use passkeys (§4.2). Instead:
- The pairing flow offers passkey enrolment while the user is at the machine (§5.3).
- A workspace setting, **"Privileged actions need a passkey"** (default off), refuses browser-key step-up in that workspace. Workspaces turning it on should expect the desktop app's web mode to be unable to perform privileged actions.
- The machine-local intent log (§7.2) records the step-up as `stepUp: "browser-key"` or `"passkey"`, so the owner can see which actions had only the weaker confirmation.

### 6.6b A recent passkey covers its browser for a while

Asking for the passkey on every privileged session action got in the way. Owners run most sessions in bypass permissions, so every new session prompted. Now one passkey confirmation covers the browser that asked, for a while, the way `sudo` remembers a password.

- **Opening the window.** A passkey intent for a privileged *session* action carries `browserKeyId`, the key id of the browser asking. It sits in the body, so the passkey signs it. When the machine accepts that intent and `browserKeyId` names one of the same user's confirmed browsers, it opens a window for that browser.
- **Inside the window.** The machine accepts that browser's own key for privileged session actions (bypass permissions, pre-approved tools, "always allow" answers) and logs them as `stepUp: "passkey-recent"`.
- **Not covered:**
  - device changes (`device_certify`, `device_revoke`);
  - shell-approving share grants;
  - standing authority: trusting the orchestrator and scheduled or webhook-triggered automations (§6.6), which outlast the window;
  - any request whose body the machine can't classify.

  These still need the passkey every time. The machine decides what a window covers from its own classification of the action, not from anything the browser says.
- **Length.** The window lasts 15 minutes (`STEP_UP_WINDOW_MS`). The machine can shorten it, down to 0, with `relay-devices.json` → `passkeyWindowMinutes`, set locally with `codekin relay devices passkey-window <0-15>`.
  - It runs from when the passkey signed (the intent's `ts`, if earlier than its arrival), so a relay that holds the intent back can't push the end later.
  - It is checked against the current setting, so lowering it ends windows already open. A machine clock that steps back ends them too.
  - It ends when the passkey that opened it is removed from the device list.
- **Required passkeys.** A window opened by a passkey counts as a passkey step-up, so it also meets the workspace's (or machine's) "Privileged actions need a passkey". To be asked every time, set the window to 0.
- **Where it lives.** The machine keeps windows in memory, so a connector restart just asks again.
- **The browser's side.** The browser stores when it last stepped up (on its pin), and stops using its window a minute before the machine's would end. A step-up refusal clears its record, so a machine with a shorter window costs one refused action, then a prompt.
- **Telling the user why.** The OS prompt can't carry our text, so while the passkey prompt is up the app shows a notice saying what made the action privileged (for example "This session uses bypass permissions, so it runs commands without asking you first") and that this browser won't be asked again for up to 15 minutes (the machine may set less).

### 6.6a As built (slice 5)

- **Verifying passkeys on the machine.** The connector ships in the npm package and can't use the relay's `@simplewebauthn/server`. `server/relay/webauthn-verify.ts` is a small, dependency-free verifier for `get()` assertions:
  - It checks the type, challenge and origin (not cross-origin), the RP ID hash, user presence and user verification, and the signature.
  - It supports ES256, RS256 and EdDSA, and ignores the counter.
  - Tests check it against `@simplewebauthn/server`.

  A passkey's key id is `base64url(SHA-256(COSE_Key))[0:22]`.
- **Passkeys in the ceremony need proof.** The browser gets passkey public keys from the relay (`GET /api/auth/passkeys/keys`), so the relay could list one of its own. Before committing, the browser therefore asserts with one of the user's passkeys:
  - The challenge is `SHA-256(T("ck-enrol-passkey-v1", SPKI(kB), nonceB))`.
  - `P` holds just the passkey that answered. The reveal carries its assertion in `passkeyProofs`.
  - The machine checks the assertion against the claimed public key, with origin and RP ID taken from the relay URL in its device list.

  The browser's proof-of-possession signature also covers the proofs: `popB = sig_kB(T("ck-enrol-pop-v1", enrolId, nonceM, proofs))`. So a relay can't swap the user's assertion for one made with a key of its own. A key the user's authenticator can't sign for never gets in. Approving the code adds the passkey alongside the browser. At most 3 passkeys per enrolment.
- **Domain-separated challenges.** No passkey assertion can count for a different purpose:
  - a machine intent signs `SHA-256(T("ck-intent-v1", body))`;
  - an enrolment proof signs `SHA-256(T("ck-enrol-passkey-v1", …))`;
  - the relay's own sign-in and MFA step-up sign `SHA-256(T("ck-relay-auth-v1", relay challenge))`.

  The browser applies the last wrapping itself (`src/hosted/relayChallenge.ts`), and the relay verifies against it, pinned by a shared test vector. **The relay and the hosted webroot must be deployed together:** a cached older bundle can't sign in with a passkey. Without it, a relay could pick a sign-in challenge equal to the hash of an intent it wrote, and turn a routine Face ID into an approval on a machine.
- **Passkey intents.** `SignedIntent.webauthn` carries `credentialId`, and the assertion's challenge is `SHA-256(T("ck-intent-v1", body))`. The body's `keyId` is the passkey's key id, or `"*"` when the user picked one (`device_certify`). The signer rules are the same as for browser keys.
- **`device_certify`** (the `enrol_certify` frame) adds a browser with `addedBy: passkey:<keyId>`.
  - It is refused when "Only allow devices confirmed on this computer" (`localConfirmationOnly`) is set. That switch is available in Settings, `codekin relay devices passkey-adds on|off`, and `PUT /api/relay/devices/settings`.
  - Only a passkey certifies: a browser key, even one added by passkey, can't.
  - The browser pins `kM` **on first use** (`via: "passkey"` on the pin), because no code was typed. Signed intents don't depend on this pin, since the machine is what checks.
    - Such a pin doesn't vouch for the machine's clock.
    - A later code-confirmed enrolment replaces it.
    - L2 encrypts with such a pin and labels it "Accepted on first use" (§8.6, D8). The first draft asked for the confirmation code first.
- **`device_revoke`** (the `enrol_revoke` frame) removes one of the signer's own credentials. Machines → "Remove this browser" uses it.
- **Step-up** (§6.2). Privileged actions are:
  - `prompt_response` answers of `always_allow` or `approve_pattern`, including through `POST /api/orchestrator/sessions/:id/respond`;
  - `create_session` or `set_permission_mode` with `bypassPermissions` or `dangerouslySkipPermissions`, over WebSocket or REST;
  - creating a session, or an orchestrator child (`POST /api/orchestrator/children`), with a non-empty `allowedTools`. Pre-approved tools are a standing rule: `["Bash"]` approves every command;
  - `device_certify` and `device_revoke`.

  REST routes match the way Express does: case-insensitive, trailing slash ignored. A body that doesn't read as UTF-8 JSON counts as privileged.
  - Such an action needs a passkey intent when the signer has a passkey on the machine, or the workspace requires it. Otherwise the refusal is `intent_step_up_required`, listing the passkeys the machine accepts (`stepUpPasskeys`).
  - The browser signs privileged actions with the passkey it knows the machine trusts. It learns these from the enrolment result and from refusals, and retries a REST request once.
  - The log records `stepUp: "passkey" | "browser-key"`, and Activity shows "browser key only" in warning colour.
  - Hints the browser learns are added to what it knows; they never replace it. For step-up, the browser offers every passkey it knows the machine trusts, and signs with `keyId: "*"`. The user's authenticator answers with the one it holds, so a wrong hint can't block step-up.
  - Step-up is **enforced only when the policy is `required`**. Under `off` or `warn` a relay can send the action unsigned anyway, so step-up there only shows up in the log. `device_certify` and `device_revoke` are always verified, whatever the policy.
- **"Privileged actions need a passkey"** is a workspace setting (`workspaces.require_passkey_step_up`, migration 14).
  - It reaches connectors in `hello_ack`, and as a hub `event` when it changes.
  - Turning it off needs a recent sign-in.
  - Only the relay reports it, but the machine keeps it: once a connector hears it on, it records `requirePasskeyStepUp` in `relay-devices.json`, and only a local surface turns it off (`codekin relay devices passkey-required off`). A relay that later says "off" changes nothing.
- **One relay hostname.** The origin and RP ID a machine checks come from the relay URL it paired with. The browser uses the hostname it was loaded from. A relay reached under another name (an alias, or a `PUBLIC_URL` that differs from the pairing URL) makes every passkey intent fail. Since an enrolled passkey rules out browser-key step-up, privileged actions then need the machine itself.
- **Not built:** telling the owner's other enrolled browsers when a browser is added by passkey (§5.4); Account → Devices, "remove from all my computers". The remote policy intent came with slice 7 (§6.8a).

### 6.7 Signed share grants and grantee intents

Without this, a relay could fabricate `role: 'grantee'` with any grants it likes for any user. Owner signatures would then stop the relay acting as the owner, but not as a "grantee" with `send_prompt`.

**A grant** is a `grant` intent signed by the owner. Its `payloadHash` covers:

```json
{ "grantId": "g_…", "sessionId": "…", "granteeUserId": "u_…",
  "permissions": ["view", "send_prompt"], "granteeKeys": [{ "keyId": "…", "spki": "…" }],
  "expiresAt": 1797000000000 }
```

The grant JSON travels next to the intent so the connector can hash it and read it.

**Relay side:**
- Stores the signed grant beside the `session_shares` row.
- Attaches the grantee's valid signed grants to the principal (`signedGrants`).
- The share dialog fetches the grantee's device keys from the relay registry and shows them ("Dana · 2 devices: MacBook Safari, Pixel Chrome") before the owner signs.

**Connector side:**
- Effective grants are `relay grants ∩ verified signed grants`, minus expired grants and grants in `revokedGrants`.
- Every grantee frame must be signed by a key in `granteeKeys` of the grant covering that session.
- Grantee keys never enter the trust store. The grant is their authority.

**Lifecycle:**
- **Revocation.** A signed `grant_revoke` intent adds the `grantId` to `revokedGrants`. Revoking is the safe direction: the relay can always stop including a grant. But a malicious relay could keep replaying a revoked one, so the connector holds the revocation list itself.
- **Lifetime.** A grant lives at most 30 days, and never longer than the share's own expiry. While the owner's browser is open, it re-signs expiring grants silently (D3).
- **Signer revocation.** A grant is only as good as the owner key that signed it. When that key is revoked (§5.6), the connector drops every grant it signed at once; the owner's remaining devices re-sign the ones that should continue. Without this, revoking a stolen browser key would leave its grants alive for up to 30 days.
- **A grantee adds a device.** The owner sees "Dana added a new device. Allow it on 'api-fix'?" and has to act; this re-signs the grant. Renewal is never automatic for a *changed* key set. Otherwise the relay could slip keys in whenever the owner is online.

**Residual risk.** The grantee key set comes from the relay at share time, effectively trust-on-first-use. Device labels in the dialog and the "new device" prompt narrow this. Closing it fully needs cross-signing or the L3 transparency log.

This also gives machine-side policy a principal it can rely on. A rule such as "execution on personal-plan sessions is owner-only" becomes enforceable on the machine. Today it would depend on the relay's word about who is the owner.

### 6.7a As built (slice 6)

- **The grant.** It is a `grant` intent bound to the machine and the session. Its `payloadHash` is SHA-256 of the grant JSON text exactly as signed. The text travels next to the intent as `SignedGrant { grant, intent }`. `grantId` is `<share id>:<issued>`: the relay's share id, then when the owner's browser first signed this grant (milliseconds in base 36, then 8 random hex digits), dated by the **machine's** clock. Before signing or renewing, the owner's browser sends a clock probe (`enrol_time`) with a fresh nonce. The machine answers `sign_kM(T("ck-machine-clock-v1", nonce, String(machineTime)))`. The browser accepts the answer only against a pin confirmed with the codes, and only for a round trip under 5 seconds; it uses the midpoint. So the relay can't choose the time, replay an old answer, or shift it by more than about 2.5 seconds. Without such an answer nothing is signed or renewed, so a browser added with a passkey alone (its pin taken on first use) confirms itself with the codes before it can sign grants. The grant intent's `ts` comes from the same clock. The machine refuses a grant whose issue time is more than 5 minutes after its intent's `ts`. The relay refuses to store one whose `ts` is more than 5 minutes from its own clock, so an owner with a wrong clock is told at once.
- **The relay** stores the signed grant on the share (`PUT /api/shares/:id/grant`, migration 15).
  - It checks only that the grant describes that share: same id, session and grantee; no permission the share lacks; at most 30 days and within the share's own expiry. The machine checks the signature.
  - It attaches the grantee's unexpired grants to every principal it forwards (`signedGrants`).
  - Changing a share's permissions drops its grant until the owner signs again. Storing a new grant closes the grantee's open sockets to that machine, so they reconnect carrying it.
- **The connector.** A grant counts only if all of these hold:
  - its intent verifies against an owner credential **currently** in the device list, so revoking that key drops every grant it signed at once;
  - it names this machine and this grantee, and the hash matches;
  - it hasn't expired, and lasts at most 30 days from signing;
  - it isn't covered by `revokedGrants` (below);
  - if it includes `approve_shell`, it was signed with a passkey whenever step-up applies.

  The grantee's effective grants are the relay's grants intersected with the verified ones. The existing channel and REST policy then works from those. This is **enforced under `required`**; under `off` and `warn` the relay's word stands, as it does for unsigned traffic. Grantee intents must be signed by a key listed in the grant for that session (any of their grants, for machine-level actions). Grantees can't use passkeys or take privileged actions.
- **Revocation.** Revoking a share also sends a `grant_revoke` intent (the `enrol_grant_revoke` frame), signed by the owner, to the machine. Revoking `X` covers `X` and every `X:…`. A **supersede** (`grant_revoke` with `keep`) covers `X` and every `X:…` issued no later than `keep`, other than `keep` itself. The machine keeps one entry per share (a full revocation outranks any supersede; of two supersedes, the one keeping the later grant wins) and never lets one lapse: another of the owner's browsers may still re-sign an old grant with a fresh date. The list is capped at 10,000 shares; past that a new revocation is refused, so it stays pending in the owner's browser, rather than an old one being dropped. The machine confirms with `sign_kM(T("ck-grant-revoked-v1", grantId))`, or `T("ck-grant-revoked-v1", grantId, keep)` for a supersede. The owner's browser keeps revocations in IndexedDB and retries them hourly until that confirmation verifies against its pinned machine key. A relay's "approved" doesn't count. The share dialog shows anything still pending.
- **Grantee keys.** A grantee's browser registers its key with the relay (`POST /api/device-keys`, at most 20 active keys per user) whenever it opens a machine workspace. When it holds a grant, it signs with that key without being confirmed on the machine.
- **What the owner's browser signs.** The relay's share listing is not trusted either.
  - The browser keeps its own record in IndexedDB (`IssuedGrant`): per share, the session, member, role and end the owner chose (sharing again replaces them, so narrowing a share signs the narrower role), the current grant's exact text, every id it issued, and whether the share is revoked. Revoked entries are kept for good.
  - The grant names the recorded session and member, with permissions from the narrower of the recorded and the listed role, so a stale record never widens what another browser narrowed (the review says so). A listing that disagrees on session or member is refused. Only a share made in another browser falls back to the listing, which must then match Viewer or Editor exactly, or nothing is signed. The review then warns that this browser has no record of the share, and also when another recorded share covers the same session and member.
  - Before signing, the owner reviews the role, the full permission list, the expiry, and each device's label with a key fingerprint. For a new device, only the new one is shown.
  - Each signature gets a fresh `grantId`, and **every** new signature sends a supersede keeping it. That retires every earlier grant for the share, including ones signed in the owner's other browsers that this one never saw, so they can't be renewed back into use.
  - Revoking a share revokes its id, which covers all grants signed for it, whatever the relay presents.
  - The machine prefers a session's most recently **issued** grant (by id), then the most recently signed, so renewing an older grant never overtakes a newer one.
  - Grants carry a signed `notAfter` (the share's end as the owner chose it), which the machine enforces.
- **Renewal.** The owner's open browser re-signs, about once an hour, any grant within 7 days of expiry. It works from its own record only: the current grant of each share it hasn't revoked. It keeps the id, permissions and devices, changes only the expiry, and never passes `notAfter`. The relay's listing plays no part. A share the relay answers 404 for is marked revoked and revoked on the machine. Without usable IndexedDB nothing renews silently.
- **Open channels.** A grantee channel re-reads its effective grants whenever the device list changes, and every 5 seconds, so a revoked or expired grant also stops what the grantee receives.
- **Not built:** a notice outside the share dialog when a grantee adds a device.

Browser storage uses atomic IndexedDB read/write transactions for key creation, pending revocations and the issued-grant ledger. Concurrent tabs return the same committed browser key. A flush removes only the exact acknowledged revocations from the current queue, and a renewal cannot overwrite a concurrent revocation. The issued-ledger change and its pending revocation commit together across both object stores, so interruption cannot leave a tombstone without retry work. Conflicting supersedes that keep different grant ids with the same issue timestamp are refused without acknowledgement; the existing machine record remains authoritative and the browser retains the conflict until a later grant or full revocation covers it. This preserves already-recorded revocations from older versions. Open grantee channels check current authority on every output frame, including frames without a session id; expiry, share revocation or signer removal ends access immediately on the next frame.

### 6.8 Policy modes and migration

| Machine | Default |
| --- | --- |
| Paired after this ships | `required` from the first enrolled credential (§5.3) |
| Paired before, connector upgraded | `off` until the owner enrols a first browser. The hosted UI prompts for this ("Protect this computer: confirm this browser on it"). Enrolling switches the machine to `required`. |
| Connector without `intents` capability | The relay shows "Update Codekin on this computer". Workspaces that require the capability refuse the machine (connector version floors) |

- Only local surfaces can set `policy` back to `off`. A remote `policy` intent may only **raise** it.
- **The connector reports its policy** in `ConnectorHello` (`intentPolicy: off | warn | required`) and on change. The relay uses it for UI and for a workspace setting, **"Require confirmed devices"**, which refuses machines not in `required` with `connector_update_required` (reason "confirm a device on this computer"), the same way capability floors do. This report comes from the machine's own connector, so a forged one only weakens that owner's own machine.
- **Grace period.** A relay may give existing workspaces a grace period (for example 30 days) during which "Require confirmed devices" only warns (D7).
- In `warn` and `off` modes, the hosted UI says plainly, in the machine header, that the relay can control the machine.

### 6.8a As built (slice 7)

- **First device turns it on.** Confirming the owner's first device (the code typed on the machine) moves the policy from `off` to `required`, for new pairings and existing machines alike. A policy the owner set to `warn` is left alone. The CLI and local Settings say so when it happens.
- **Raise only.** A `device_policy` intent (the `enrol_policy` frame, payload `framed(policy)`) from a confirmed owner browser raises the policy. Lowering is refused with "Only this computer can lower its policy". Raising needs no step-up. The machine confirms with `sign_kM(T("ck-policy-raised-v1", policy, intentNonce))`; the browser shows success only on that, verified against a machine key pinned with the codes. Lowering is only possible locally: Settings → Remote access → **Control through the relay**, `codekin relay devices policy`, or `/api/relay/devices/policy`.
- **The connector reports its policy.** It sends `intentPolicy` in `ConnectorHello`, and an `intent_policy` frame within 5 seconds of a change (the CLI can change it from another process). It sends the frame only to a relay whose `hello_ack` has `policyReports: true`, because older relays close the socket on unknown kinds. The relay applies a report at once. It stores it (`machines.intent_policy`, migration 16) and audits changes as `machine_policy_changed` at most once every 10 seconds per machine, so a connector flipping its report can't flood either. It lists the policy with each machine.
- **"Require confirmed devices"** is a workspace setting (`require_confirmed_devices`, `confirmed_devices_grace_until`). It is set with `PATCH /api/workspaces/:id` `{ requireConfirmedDevices, confirmedDevicesGraceDays: 0–90 }`; turning it off or adding grace needs a recent sign-in check.
  - A machine passes only if its connector has the `intents` capability at or above the floor and reports `required`.
  - **No intents capability:** everything is refused, enrolment included, with "needs Codekin <floor> or later".
  - **Capable but not `required`:** requests and channels are refused with their own code, `devices_unconfirmed` ("confirm a browser on this computer"; updating won't help), and the connector's status is `devices_unconfirmed`. Enrolment frames still pass, since that is how the machine clears the refusal.
  - During the grace period machines are only flagged.
  - Changes apply to connected machines at once. A machine that becomes refused (the rule turned on, a lower policy reported, or a grace period running out) has its open channels closed, and its connector is told on each change. The machine list adds `intentsSupported`, so a machine that needs an update isn't told to confirm a device.
  - `PATCH` sets `requireConfirmedDevices` on its own, so nothing applies before another field is refused.
- **Floor.** `CONNECTOR_FLOORS.capabilities.intents` is `0.11.0`, the release that carries this slice.
- **Browser.** The machine header no longer exists in the hosted app (nothing is drawn over a session), so the warning sits on the machine's row in Settings → Machines:
  - "The relay can control this computer", with **Require confirmed devices** from a confirmed browser, or a pointer to confirm this browser;
  - "Update Codekin on it" for connectors that report no policy;
  - a **confirm a device** badge where the workspace refuses the machine or soon will.
- **Attack harness.** `server/relay/relay-adversary.test.ts` (§11) runs a malicious hub against a real connector, verifier and enrolment, with a stub local server that records every hit. Writing it found that enrolment requests pushed out unrevealed weren't counted against the per-window budget; they are now (`enrolAttempts`).
- **Not built:** the staging run of the harness against two real tenants (§11 staging gate) is a manual step before launch.

### 6.9 Browser UX

- **Machine list.** Each machine shows **Trusted** / **Not trusted on this browser**. The list itself is relay metadata.
- **Opening an untrusted machine.** A trust sheet offers "Use passkey" (one biometric) or "Confirm on the computer" (shows the 8-character code). Nothing loads until the browser is trusted, because reads are signed too.
- **Account → Devices.** Lists this browser's key id and label, the machines that trust it, and "Remove from all computers".
- **Refusals.** These are rare and mean either a bug or an attack, so they appear as visible notices, not silent retries.

---

## 7. Audit

### 7.1 Relay audit events

**Built** (`server/relay/session-audit.ts`, `browser-hub.ts`). These ship first, before L1, and work on unsigned traffic too. `device_enrolled`, `device_revoked` and `intent_rejected` come with slices 3–4. `session_created` is recorded from the machine's `session_created` reply on a stream, or from a successful `POST /api/sessions/create`. Stream events carry the session acknowledged by the machine. Pending transitions have no session attribution; connector refusals preserve the previous confirmed session, and confirmed leaves clear it. Audit metadata marks forwarded traffic as `outcome: forwarded`, not proof of local execution. Every transport-accepted browser frame is classified, including whitespace-prefixed JSON and large prompts. `GET /api/workspaces/:id/audit` filters by `kind` (comma list), `machineId`, `sessionId` and `actor`; there is no audit UI yet.

| Event | Emitted when the hub forwards | Metadata (no content) |
| --- | --- | --- |
| `prompt_sent` | `input`, `review_feedback_send` | `sessionId, payloadHash, keyId?, signed` |
| `approval_answered` | `prompt_response` | `sessionId, requestId, decision class (approve / deny / always / other), payloadHash, keyId?` |
| `file_uploaded` | `POST /api/upload` | `bytes, contentType, payloadHash, keyId?` |
| `session_stopped` | `stop` | `sessionId, keyId?` |
| `session_created`, `permission_mode_changed` (new) | as named | `sessionId?, mode?` |
| `device_enrolled`, `device_revoked` (new) | `enrol_result`, revoke acknowledgements from the connector | `keyId, kind, addedBy` |
| `intent_rejected` (new) | connector `not_permitted` with an `intent_*` detail | `detail, action, keyId?, intentNonce` |

**Implementation:**
- One `auditForwardedFrame(client, frame, intent?)` helper in `browser-hub.ts`, called from `forwardChannelData` and the REST forward.
- Before L1, `payloadHash` is computed by the relay. After L1 it is copied from the intent.
- Every event carries the actor, machine and workspace, as `recordAuditEvent` already does.
- No prompt text, file names or tool input. For uploads, record the byte count only.
- Under L2 the relay can't parse frames. It audits from a clear, machine-checked action label instead (§8.9).

The relay's audit is only as honest as the relay. That is fine for team accountability. Tamper resistance comes from the machine's log in §7.2.

### 7.2 Machine-local intent log

`~/.codekin/relay/intents.jsonl`, mode 0600, append-only. Each line:

```json
{ "seq": 4182, "prev": "sha256 of previous line", "at": "…", "verdict": "accepted",
  "action": "ws:input", "sessionId": "…", "userId": "u_…", "keyId": "q3…",
  "payloadHash": "…", "intent": { "body": "…", "sig": "…" } }
```

- Hash-chained and content-free. The stored intent proves who signed what.
- Rotated at 30 days or 50 MB.
- Shown in local Settings → Remote access → Activity, filterable by device and session.
- `codekin relay audit verify` checks the chain. **Planned in slice 11:** `--against <export>` compares the machine's log with the relay's export, with explicit incomplete-coverage results (§8.9). The current CLI checks only the local chain.

---

## 8. End-to-end content encryption (L2)

**Revision 3 (2026-11-15), not built.** Revision 2 was re-based on `main` at v0.12.1 (`04d5e4b`), after L1 shipped and the app gained the trust token (§5.2b), passkey windows (§6.6b), Canvas, places and webhooks. Revision 3 closes the audit findings against the existing transport and verifier; D14–D16 record the versioning, retry and release-gate changes. The design keeps these decisions from revision 2:

- Two handshake messages instead of three (D9).
- Intents are bound to the encrypted session, so a relay can't unwrap them and replay them in clear (§8.5).
- The audit label carries the intent nonce instead of an HMAC of the content. `kAudit` is gone (D10, amends D4).
- A browser added by passkey gets encryption at once, with the machine key taken on first use, instead of a trip to the machine (D8, amends D6 and §6.6a).
- Machines and browsers remember that they used encryption and refuse to go back (D11).
- Sealed payloads travel in the existing envelope kinds, and the bindings no longer use ids the hub rewrites (D12).

### 8.1 Goals, and what the user does

**Security goal.** The relay carries session content it can't read: prompts, replies, tool calls, diffs, files, Canvas items, settings and every REST body.

**Usability goal: the user does nothing on an L1-protected connection.** L1 already put a key in each browser and a pinned machine key next to it. L2 uses those and adds no step. Deliberate local L1 `off`/`warn` overrides retain their existing confirmation/policy flow (§8.7).

| Concern | Answer |
| --- | --- |
| Turning it on | Automatic, once the computer, the relay and the page all support it. No switch, no opt-in |
| New prompts or ceremonies | None. A browser that can control a computer can encrypt to it |
| Passwords, recovery keys, key backup | None. Nothing is stored encrypted, so nothing can be lost. A browser that loses its key confirms again, as in L1 |
| Speed | At most one extra round trip when a connection opens (§8.13). Nothing the user can see per message |
| People a session is shared with | Nothing to do |
| What the user sees | A lock on the computer's row in Settings → Machines, and actionable connection failures (§8.12) |

Any proposal that adds a step for the user on the common path needs its own decision in §13.

### 8.2 Design choice: per-connection keys, not per-session wrapped keys

The audit suggested "per-session keys wrapped to enrolled devices". That design suits a server that **stores** ciphertext for devices to read later, as in messaging apps. The relay stores no content (§2.4). Everything it carries is live traffic between one browser socket and one connector. So:

- **Use:** an authenticated ephemeral key exchange per browser↔machine relay connection.
- **Why it's better here:**
  - forward secrecy
  - no key distribution or rotation across devices
  - no wrapped-key store on the relay
  - nothing breaks when a device is revoked
  - nothing for the user to back up
- **Add per-session content keys** only if a feature stores content on the relay: offline message queues, push notifications carrying text, synced transcripts. That design is sketched in §8.15 so it can be added later without a protocol break.

Session history stays where it is: on the machine, in `~/.codekin` (`sessions.json`, per-session history files, `session-archive.db`). L2 protects traffic. It doesn't encrypt files on the machine.

### 8.3 Handshake

One handshake per `RelayConnection` (one browser socket to one machine). It covers REST and every stream channel on that socket. It uses the L1 keys: the browser key `kB` and the machine identity key `kM`. No new long-lived keys are created.

```
B: eB ← ECDH P-256 ephemeral; nB ← 32 random bytes
   e2e_init { v: 1, eB, nB,
              intent(v: 2, action: 'e2e:init', sessionId: null,
                     payloadHash = SHA-256(T("ck-e2e-init-v1", eB, nB))) }   ──►
M: require an accepted signature: key in the trust store or in a valid
   grant, principal matches, timestamp fresh, nonce unused.
   eM ← ECDH ephemeral; nM ← 32 random bytes
   auditMode = 'actions' | 'connections' (§8.9)
   H   = SHA-256(T("ck-e2e-accept-v1", machineId, userId, keyId, eB, nB, eM, nM,
                  auditMode))
   sid = base64url(H)[0:22]
   e2e_accept { sid, eM, nM, auditMode, sigM = sig_kM(H) }                    ◄──
B: verify sigM with the kM this browser pinned (§8.6). If it fails, stop (§8.12).
Both: ikm = ECDH(e_self, e_peer)
      k_b2m ‖ k_m2b = HKDF-SHA-256(ikm, salt = nB ‖ nM,
                                   info = T("ck-e2e-keys-v1", H), 64 bytes)
```

- `T(label, fields…)` is the transcript encoding enrolment already uses (§5.2, "As built"): a domain label, then each field as a 4-byte length and its bytes.
- **Encoding.** Ephemerals are uncompressed SEC1 P-256 points (65 bytes, `0x04 ‖ x ‖ y`); nonces are exactly 32 bytes. Both travel as unpadded base64url and enter transcripts as decoded bytes. Identity fields are UTF-8; `H` enters signatures and HKDF as its raw 32 bytes. Reject invalid points, wrong lengths, unsupported versions and non-canonical encodings. The browser recomputes `H` and `sid` rather than trusting the returned `sid`.
- **Authority.** L2 content connections require L1 policy `required`. A local `off`/`warn` override retains the existing L1 warning and cannot advertise the machine as protected by L2. In every mode the handshake and version-2 binding checks fail closed: the verifier's `forward` flag under `off`/`warn` is not an accepted signature. Bind the encrypted session to the authenticated user, role and browser key. Each decrypted request is authorized again against that identity and current trust/grants; a passkey step-up must belong to the same owner. A relay-supplied principal cannot replace the session's identity or widen its authority.
- **Wire.** `e2e_init` and `e2e_accept` are new envelope kinds, correlated by `id` and handled by the connector itself, like the `enrol_*` frames. The hub attaches the principal and forwards.
- **Why two messages are enough.** The first draft had a third, `e2e_confirm`, carrying the browser's signature over the transcript.
  - The browser is already authenticated: the `e2e:init` intent is signed by `kB` and covers `eB`, the machine and the key id. Only the holder of `eB`'s private half can derive the keys.
  - The machine is authenticated by `sigM`, which covers both ephemerals, both nonces and both identities.
  - A replayed `e2e_init` is refused by the nonce store. If one were accepted, it would create a session nobody can use.
  - The machine sends nothing under the new keys until it has opened a valid sealed frame from the browser. That frame is the key confirmation.
  - No separate confirmation round trip is needed; the first normal sealed request confirms the keys. A healthy resumed socket keeps its keys (§8.8).
- **Clock.** A stale `e2e:init` gets the existing `intent_stale` answer with the machine's signed time (§6.5), and the browser retries once.
- **Only a browser key signs `e2e:init`.** Passkeys don't, so opening a connection never shows a passkey prompt.
- **One implementation.** The exchange, key derivation and sealing live in one WebCrypto-only module that the connector (Node ≥ 22.14) and the browser both import, as `intent-actions.ts` is today. Test vectors pin it.

### 8.4 Sealed messages

Sealed payloads travel in the existing envelope kinds: `request`, `response`, `stream_open` and `stream_data`. The payload is one of two shapes, and the hub tells them apart by the `sid` field:

```ts
interface Sealed {
  sid: string          // which encrypted session (§8.3)
  seq: number          // counter for this sid and direction, starting at 0
  ct: string           // base64 AES-256-GCM ciphertext and tag
  label?: AuditLabel   // clear, authenticated, §8.9
}
```

- **Cipher.** AES-256-GCM with a 128-bit tag. The 96-bit nonce is four zero bytes and `seq` as a big-endian uint64. Each direction has its own key, so the two directions never share a nonce. On the wire, `seq` must be an integer in `0..2³²−1`; no wrapping or resetting with the same key. Retire the session before the next frame would exceed that range.
- **Order.** `seq` must be greater than the last one accepted for that `sid` and direction. A gap is allowed: a relay can drop traffic. A repeat or a step back ends the encrypted session. Existing slow-client backpressure still closes the affected channel.
  - Both endpoints have one seal/send queue and one open/dispatch queue per encrypted session. Allocate each sequence once, send ciphertext in that order, and advance the receive counter only after authentication. Dispatch may start concurrent REST work; seal replies in completion order, without serializing the REST work itself. Bound queued bytes and discard work belonging to retired sessions.
- **Additional authenticated data:** `T("ck-e2e-aad-v1", sid, kind, ref, labelBytes)`.
  - `kind` is the envelope kind.
  - `ref` binds the message to its place. The hub rewrites channel ids and request ids (`browser-hub.ts`, `connector-hub.ts`), so `ref` uses values both ends know without the hub:
    - `stream_open`: empty. Its sealed header carries the browser's own channel id, and the connector binds it to the channel.
    - `stream_data`: the browser's channel id from that `stream_open`.
    - `request`: empty.
    - `response`: the request's `seq` encoded as an unsigned decimal UTF-8 string. The browser obtains it from its pending request, not from an untrusted response field.
  - `labelBytes` is the canonical UTF-8 encoding defined in §8.9, or empty. JSON object property order in the relay envelope is irrelevant.
  - So the hub can't move a frame to another channel, pair a response with another request, or change a label.
- **Plaintext.** `uint32 header length ‖ header JSON ‖ body bytes`. The body is raw bytes, so a file upload is base64-encoded once, not twice.

  | Kind | Header | Body |
  | --- | --- | --- |
  | `request` | `{ method, path, contentType?, intent }` | request body |
  | `response` | `{ status, headers }` | response body |
  | `stream_open` | `{ channel, intent }` | empty |
  | `stream_data`, browser → machine | `{ intent }`, absent for locally consumed `ping`, `resize` and `auth` | the Codekin frame, UTF-8 |
  | `stream_data`, machine → browser | `{}` | the Codekin frame, UTF-8 |

- **What stays clear.** `id`, `channelId`, the principal the hub attaches, `stream_close`, `error` codes and the intent refusal fields of §6.4, `ping`/`pong`, `hello`, and the enrolment frames. Clear messages are untrusted hints, never proof of successful execution or non-execution. Close/error text uses fixed content-free messages; never include decrypted paths, bodies or local exception text. Existing signed clock proofs remain required. Enrolment keeps its own authentication rules.
- **Limits.** The 8 MiB body limit applies to the plaintext body. Bound the header separately at 64 KiB; check its uint32 big-endian length before parsing UTF-8 JSON. Preserve the existing method/path/header allowlists after decryption. A sealed envelope, including its label, must fit the socket's `maxPayload`; reject oversize input locally before sending. Test exact-limit uploads and maximum stream frames, including base64 expansion.
- **Failures.** A message that doesn't open ends that encrypted session and all channels attached to it. The connector answers `e2e_failed`, or `e2e_unknown` for an absent `sid`. The browser may re-handshake once per failed operation; subsequent transport recovery uses the existing backoff. Recovery never silently changes to cleartext and never treats either error as proof that a pending action did not run.

**Retry contract (D15).** An operation's nonce identifies the operation across encrypted sessions, signing keys and transport attempts. A re-handshake may require a new signature containing the new `sid`; it must not create a new operation nonce.

- Keep the existing account-scoped, durable replay store, independent of `sid`. A retry keeps the payload, target, nonce and original signed timestamp; the existing authenticated clock-correction retry may adjust the timestamp within its bounded lifetime. Never convert a version-2 operation to version 1.
- Retry at most once and within 60 seconds of the original attempt. `intent_replayed` means the operation was consumed, not that it completed successfully. A consumed nonce is not re-executed and does not imply a cached successful response.
- Reads and reconnect subscriptions can be re-established safely. A queued operation known never to have been sent can be signed for the new session. For a sent mutation with no authenticated outcome, preserve the draft and reconcile observable state; if the outcome remains unknown, show the existing action error with “The connection was lost; check whether this action completed before trying again.” Do not automatically submit it under a fresh nonce.
- Connector restart, timeouts, lost replies and forged clear errors follow the same rule. Reopening a stream does not replay its pending prompts, approvals or creation actions. Close old channels and create fresh channel tokens; do not transplant old per-channel intent sequences to a new channel. This preserves at-most-once execution within the replay window; it does not promise exactly-once delivery.

### 8.5 Binding intents to the encrypted session

Intents stay inside the ciphertext. They still do three jobs: authorization on the machine, the signed local log (§7.2) and step-up (§6.6).

An optional field alone is insufficient. Existing L1 connectors accept version-1 intents with unknown fields, including `e2e`. A relay that supplies a false first-use machine key could decrypt the browser's requests and forward their signed intents in clear to such a connector.

**D14: version the signed intent, not just the envelope.**

- All L2 transport intents use signed `IntentBody.v: 2`. The `e2e:init` intent is version 2 with no `e2e` field, because no session exists yet; it is accepted only by the handshake handler. Every intent inside ciphertext is version 2 with mandatory `e2e: sid`.
- Version 1 remains for clear L1 traffic and existing enrolment/grant operations. Sealed transport never accepts version 1. Version 2 is never accepted on a clear content request, even when a local L1 policy is `off` or `warn`. A version-1 intent with an `e2e` field is also refused by new connectors.
- The connector refuses a mismatched/missing `e2e` (`intent_e2e_mismatch`) before forwarding. These transport checks apply independently of the L1 policy. Nested owner-signed grants retain their existing version; the transport operation carrying them is separately bound.
- A legacy L1 connector at `required` rejects version 2 before execution. This is why a relay cannot unwrap new signatures into valid old requests. A capability advertisement or relay-enforced version floor cannot provide this guarantee against a malicious relay.
- A relay that can decrypt a fake session must use its own ECDH secret, giving that session a different `sid` from the real handshake. Passing through the real ephemerals does not reveal the real keys. Thus requests signed for the fake fail on both legacy `required` connectors (version) and L2 connectors (session binding). Machines deliberately left at L1 `off`/`warn` do not have this authorization guarantee (§8.3).

### 8.6 Which machine key a browser trusts

The handshake is only as good as the browser's copy of `kM`. Three cases exist today:

| Browser | How it learned `kM` | Pin |
| --- | --- | --- |
| Owner, confirmed with the pasted command or the codes (§5.2, §5.2b) | A machine-local action authenticated the key: the secret trust token or the completed code ceremony | **Verified** (`via: 'code'`) |
| Owner, added by passkey (§5.4) | From the relay, on first use | **First use** (`via: 'passkey'`) |
| Grantee | From the relay, on first use | **First use** |

**Decided (D8): first-use pins get encryption at once, with no prompt.**

- The first draft, and the as-built note in §6.6a, said a first-use pin must be confirmed with a code on the machine before L2 trusts it. That sends the most convenient path (a phone added with one Face ID) back to the computer, and it gives grantees no path at all.
- A malicious relay at first use can impersonate the machine, read anything that browser sends to the fake, and fabricate convincing session lists, replies or other content. An empty session list is not a reliable warning. Impersonation alone does not let it decrypt the real machine's traffic or execute the captured version-2 intents on an L1 `required` machine (§8.5). Separately, §6.7's grantee-key substitution risk remains: an owner who signs a relay-substituted grantee key can authorize that key to read a real shared session. L2 does not solve either initial identity-distribution problem.
- A relay that is honest at first use can never substitute the key later. A changed key is refused (§8.12).
- The claim stays honest: the detail sheet says "Accepted on first use" and offers **Verify** (§8.12).

**Pin migration and writes.** Current passkey certification permits replacing a `via: 'passkey'` pin; L2 must change that path, not just the handshake. Preserve existing pins (including first-use pins) on upgrade. Pin creation uses an IndexedDB read/write transaction: concurrent first connections must agree on one key or fail with an identity-change error. Every writer—certification, enrolment, step-up hints, verification and credential removal—preserves the encryption-required bit and verification provenance. Removing a browser credential retains the machine's identity/encryption record so later re-enrolment cannot silently downgrade it. Same-key updates never demote a verified pin. A different key is installed only after the explicit authenticated replacement flow below; passkey recertification alone cannot replace it. The encryption-required bit survives a verified replacement.

**Upgrading a first-use pin to verified.** Each is optional:
- Paste the trust command or type the code on the machine (§5.2b). This exists today.
- Compare the full SHA-256 SPKI fingerprint in the detail sheet with the one `codekin relay devices list` or local Settings shows. Record verification only after the user confirms that independent comparison.
- Later: bind the pin to the passkey itself, with no user step (§8.15).
- Later: the transparency log of L3 (§12).

**Grantees.** D6 put an owner-signed `kM` fingerprint in the grant. A grantee's browser has no trusted copy of the owner's key to check that signature with, so the fingerprint adds nothing against a relay. It is dropped (D8). Optional Verify shows the fingerprint and asks the grantee to check it with the owner over an independently trusted channel. It never asks the grantee to enrol as an owner or run a local command. For a changed key, block content until that comparison confirms the replacement; an owner must also renew any grants invalidated by re-pairing. A key or fingerprint delivered solely through the same relay is not independent confirmation.

**Re-pairing** creates a new machine identity (§4.1). Every pin breaks, every browser confirms again, and grants are re-signed. This is L1 behaviour and stays as it is.

Owners replace a changed pin through the existing local trust-token/code ceremony, presented as **Confirm replacement**. Keep the old pin until the ceremony authenticates the replacement, then replace it atomically; never require forgetting the old pin first. Losing all browser site data loses pins as in L1 and requires confirmation again; documentation must not promise pin continuity after storage deletion.

### 8.7 No going back to clear text

Without this, a relay could strip the `e2e` capability from what it tells each side and keep everything readable.

- **Machine.** The trust store gains `"e2e": "auto" | "required" | "off"`, default `auto`.
  - `auto`: encrypt with every browser that offers it; accept clear L1 traffic from the rest.
  - `off`: a deliberate local override disabling L2; it does not alter L1 enforcement or erase browser pins. It is never set by remote negotiation.
  - On the first authenticated, authorized sealed operation, set an in-memory cleartext barrier and atomically persist `required` **before forwarding that operation or releasing content**. Close existing clear content channels, cancel clear requests not dispatched, and suppress outstanding clear responses. Already-dispatched local actions may complete; do not resend them. No content is emitted in clear after the barrier, including output from an older open stream. Subsequent clear content traffic gets `e2e_required`.
  - Failed persistence keeps the process closed to clear content and refuses the triggering operation; it never silently proceeds in `auto`. An unreadable policy store fails closed. The transition uses the existing trust-store lock so another local writer cannot overwrite `required` with a stale copy.
  - A new owner-only `enrol_e2e_policy` operation may raise the policy to `required`, never lower it. Its existing-format signed `device_e2e_policy` intent covers the requested policy; the machine checks it regardless of L1 mode and acknowledges with `sign_kM(T("ck-e2e-policy-raised-v1", machineId, policy, intentNonce))`. Apply the same barrier and persistence rules. Local-only lowering uses `codekin relay e2e status | auto | required | off`, or Settings → Remote access.
- **Browser.** After verifying the handshake, atomically persist the machine pin and its encryption-required bit before sending content. Until then, hold outgoing content. A storage failure refuses this attempt with an actionable storage error, not a cleartext fallback. Every tab rechecks the committed pin before its first content send and reacts to pin changes; a changed pin ends affected sessions. A remembered requirement overrides relay capability hints and machine-list metadata.
- **Exceptions.** The cleartext barrier covers content requests, responses and streams. Enrolment, signed clock/policy operations, heartbeat and the narrowly scoped HMAC-authenticated GitHub webhook route remain available under their existing checks. They must not become a general cleartext proxy.
- **Relay capability.** The hub says in `hello_ack` whether it carries sealed payloads (an older self-hosted relay closes the socket on unknown frames). A connector in `auto` under such a relay stays in clear and says so. A connector in `required` refuses traffic, and the UI names the fix (§8.12).
- **What remains.** A relay can hold a machine in clear until its first encrypted connection. The lock is absent for that time, so the UI never claims more than is true.
- **Needs L1 enforcement.** Encryption applies to an owner key the machine trusts or a grantee key in a verified grant, with L1 policy `required` (§8.3). Existing `off`/`warn` machines retain the existing confirmation/raise-policy flow and warning. New pairings confirm a browser as part of pairing (§5.3), so they encrypt from the first connection.

**Intentional local lowering is not browser recovery.** Setting `auto` or `off` changes what the machine accepts; it does not clear any browser's remembered requirement. Previously encrypted browsers remain blocked on an older relay. The supported recovery is to update/restore the relay, or use the local UI while doing so. Do not suggest clearing site data, forgetting a pin or downgrading as a reconnect fix. This avoids introducing a remote bypass or another confirmation ceremony.

### 8.8 Connection lifecycle

| Event | What happens | What the user sees |
| --- | --- | --- |
| Page opens a computer | `hello`, then `e2e_init`. When the pin says this machine encrypts, both go out together, without waiting for `hello_ack` | Nothing |
| Reconnect after a lost socket | New socket, new handshake, new keys; pending operations follow §8.4 | Existing reconnect; an uncertain mutation may need its existing action error |
| Phone unlock (`resume()`) with a healthy socket | Keep the existing socket and keys; use the existing liveness probe. Replace only a dead socket or an expired encrypted session | No forced reconnect or history replay |
| Second tab | Its own socket and its own encrypted session, same browser key | Nothing |
| Connector restart | Encrypted sessions are in memory and are lost. Reconnect/re-handshake and restore subscriptions; reconcile pending mutations under §8.4 | Existing reconnect; never a duplicate prompt or creation |
| Connection open for a day | The browser reopens its socket at the next quiet moment after 24 hours, so keys don't live for weeks in an always-open tab. There is no in-place rekey | Nothing |
| Browser revoked, or a grant narrowed or dropped | The connector deletes that key's encrypted sessions along with its channels (as #841 does for open output) | The existing "confirm this browser" or "access changed" state |
| 2³² frames in one direction | The connector ends the session; the browser handshakes again | Nothing |

The connector bounds what it holds: at most 32 encrypted sessions per credential and 256 per machine, oldest idle first out, and a session with no open channel is dropped after 30 idle minutes. Creating one needs a valid signed intent, so a relay can't fill the table by itself.

Revocation, expiry and narrowed grants are checked before dispatch and before releasing each response/output frame, including a REST response that completed after authority changed. Delete the affected session's keys and close its channels. Session retirement and reconnect cancel queued crypto work and prevent late replies from reaching a replacement socket. A 24-hour refresh waits for pending mutations to settle; it never forces their replay. Sequence exhaustion instead pauses sends before the limit and recovers with the same retry contract.

### 8.9 Audit labels

The hub classifies traffic today by parsing it (`session-audit.ts`: `classifyBrowserFrame`, `SessionAuditState.observe`, `classifyRestRequest`, and reading the session id out of a create response). None of that works on ciphertext. Labels replace it.

```ts
interface RequestAuditLabel {
  type: 'request'
  action: string            // allowlisted audited action, matching the intent
  sessionId: string | null  // exact intent value, including an @created:N marker
  keyId: string             // exact intent value (may be '*' for passkey step-up)
  nonce: string             // operation nonce, unchanged on retry
  detail: string | null     // allowlisted approval class or permission mode
}
interface CreatedAuditLabel {
  type: 'session_created'
  sessionId: string         // actual id acknowledged by the local server
  nonce: string            // nonce of the originating create operation
  creationRef: string | null // @created:N for a stream creation; null for REST
}
type AuditLabel = RequestAuditLabel | CreatedAuditLabel
```

- **Encoding.** Canonical label bytes are UTF-8 `JSON.stringify` of a fixed array: `["request", action, sessionId, keyId, nonce, detail]` or `["session_created", sessionId, nonce, creationRef]`. Use explicit `null`, no omitted slots. Reject unknown fields/types and overlong values before encoding. Bound action to 256 characters, ids/session markers to 200, key ids/nonces to 64, and detail to 64; detail and action must come from shared allowlists. A missing label encodes to zero bytes. Test vectors include reordered envelope properties and escaped strings.
- **Sent only for audited actions.** Add a shared, browser-safe classifier to `intent-actions.ts`, porting the existing `session-audit.ts` rules. Request labels cover prompts, approvals, stop, permission-mode changes, uploads and session-creation requests. A creation request is an attempt, not a `session_created` event. Reads, joins and other actions carry no label.
- **The machine checks it.** The label is in the additional authenticated data. Before forwarding, the connector compares it with the authenticated intent and independently derives `detail` from the decrypted payload. Missing required labels, labels on unaudited actions and mismatches are refused (`label_mismatch`) and logged. `keyId: '*'` remains the signed value; the local log separately records the credential actually verified. The relay records a forwarded attempt, not proof of acceptance or execution.
- **No content hash or content-derived tag reaches the relay** (D10). The nonce is the correlation id; allowlisted action/detail categories remain visible. It is not a content commitment or a signature the relay can verify. The local log retains the signed intent and its payload hash. Comparison keys are machine, user, operation nonce and event type, not nonce alone or line order.
- **Session attribution.** Request labels retain the exact signed `sessionId`, checked against the channel. Existing L1 uses `@created:N` after a stream creation, where `N` is the creation intent's channel sequence. This is not an actual session id. The connector correlates the local server's creation acknowledgement with the pending create nonce and marker, and emits a `CreatedAuditLabel` on that sealed reply. REST creation uses the request nonce and `creationRef: null`. Record the same creation receipt in the machine's hash-chained log. Do not emit a receipt for failed creation or an uncorrelated server event.
- **Resolving creation markers.** The relay may resolve a marker only from the corresponding creation receipt, scoped to machine, encrypted `sid` and channel. Never join markers across channels, tabs or reconnects. A missing receipt leaves attribution unresolved; do not guess from the last session. The browser verifies that the receipt agrees with the decrypted reply and pending creation. Neither endpoint trusts a relay-built mapping.
- **Comparison and coalescing.** Implement `audit verify --against <export>` in slice 11; it is not an existing command option. Compare forwarded attempts separately from accepted/rejected local intents and creation receipts. Deduplicate retries by operation identity. Exports identify their time range, audit mode and coverage gaps. Existing budget coalescing loses individual nonces: retained events can match, but a coalesced count cannot prove which omitted operations occurred. Report matched, conflicting and unmatched records, plus **incomplete coverage** for coalescing, disabled labels, retention or export gaps. Missing rows are discrepancies to investigate, not by themselves proof of relay tampering. Never report an exact match over incomplete coverage.
- **What the relay's rows lose under L2:** `payloadHash` (replaced by `intentNonce`), and the upload's content type and exact byte count.
- **"Connection-level audit only"** (workspace setting, D4) drops both label types. The hub announces it to both ends; the connector signs the selected audit mode into the acceptance transcript `H` (§8.3). The browser takes the mode from that authenticated acceptance; changes take effect on a new handshake. In `connections` mode both endpoints omit labels and reject supplied labels. This prevents conflicting mode hints breaking the connection. The setting is relay-controlled, not protection against an operator choosing to suppress audit records. The local intent log remains enabled in either mode.

### 8.10 What the relay still sees

- account, workspace, machine and channel ids, and connection times
- frame counts, sizes and timing
- `principal`: who is asking, and their relay-side grants
- audit labels (§8.9), unless the workspace turned them off
- which sessions are shared with whom: shares are relay records and name the machine's session ids
- each machine's session counts (total and active), which the connector reports for the machine list
- device labels ("Safari · iPhone"), machine names, public keys and enrolment traffic
- **GitHub webhook deliveries** it forwards (§9). GitHub sends them in clear, so they are outside end-to-end encryption. The claim in §8.12 says so
- error and CSP reports from the web app. These must stay content-free: `error-scrub.ts` already strips them, and the pre-default gate adds a test that a canary in a session never appears in a report

### 8.11 Relay-side filtering moves to the connector

Four relay-side content checks stop working on sealed traffic:
- `isServerFrameVisible` on grantee streams (`browser-hub.ts`)
- `checkRestPolicy` on grantee REST paths (`browser-hub.ts`)
- the audit classifier (§8.9)
- `isWellFormedStreamData` in the connector hub's abuse signals (`connector-hub.ts`); a sealed payload has no clear `data` field and must not count as malformed content

The first two already run on the connector (`checkServerFrame`, `checkRestPolicy`); the relay repeats them for older connectors. Plan:
1. Advertising `e2e` requires a connector version that includes those checks. Slice 11 sets that version as the floor for the `e2e` capability (`connector-version.ts`).
2. On sealed payloads the hub skips content inspection. The connector performs authorization after decryption; the capability floor is compatibility protection for an honest hub, not an authentication boundary.
3. Abuse detection validates only the sealed envelope shape, sizes and rates. Count malformed clear content separately from malformed sealed envelopes; exclude valid ciphertext from the clear-content ratio. Test with abuse rules enabled, including rules that disconnect a machine.
4. A test asserts the hub never decodes or parses ciphertext, and a lint rule keeps content helpers out of the sealed path. Parsing envelopes and allowlisted labels is permitted.

Grantee REST is still limited to `GRANTEE_ROUTES`. The connector enforces that after decrypting.

Everything else the hub does is unaffected, because it never looked at content: rate limits, quotas, byte metering, backpressure, heartbeat and re-authorization.

### 8.12 UX, copy and failure states

**The lock.** One quiet indicator on the current computer's row in Settings → Machines, alongside the existing trust information. Its detail sheet is available from that row whether encrypted or not. There is no hosted computer header and no new overlay over the transcript. Derive the lock from this browser's authenticated connection, never from the relay's machine metadata; other machines' rows must not imply a live encrypted connection.

| State | Shown | Detail sheet |
| --- | --- | --- |
| Encrypted | Lock, "End-to-end encrypted" | Fingerprints of the computer's key and this browser's key. Verification: "Confirmed on the computer", "Fingerprint checked", or "Accepted on first use" with **Verify** (§8.6). For first use: "This computer's identity has not been independently checked." |
| Not encrypted | No lock | "Encrypted in transit. The relay can read session content." Name the actual unmet prerequisite: computer update, relay update, page reload or L1 confirmation/policy. Do not always prescribe a computer update |

No banner, badge or nag for the second state, unless the workspace requires encryption.

**Failure states.** Each has one primary action and no "continue anyway". The normal path adds no prompts. Existing connection/action errors handle uncertain mutations (§8.4); pin-storage failure is a distinct actionable error rather than an endless reconnect.

| Cause | Message | Action |
| --- | --- | --- |
| The machine's key differs from the owner's pin | "This computer's identity changed. If you set it up again, confirm this browser on it." | **Confirm replacement**, opening the existing local confirmation sheet (§8.6) |
| The machine's key differs from a grantee's pin | "This computer's identity changed. Check the new fingerprint with its owner." | **Verify with owner**, opening the comparison flow (§8.6) |
| The machine requires encryption and the page is too old | The existing "Update the page" notice | Reload |
| The machine or browser requires encryption and the relay can't carry it | "This relay can't carry encrypted sessions. Its administrator needs to update or restore it." | **Relay update instructions**; local policy lowering does not reset browser pins |
| Browser cannot save its machine pin | "This browser couldn't save this computer's identity. Allow site storage, then retry." | **Retry**, after storage is available; preserve existing pins and send no content |
| Machine cannot persist the encryption requirement | "This computer couldn't save its security settings. Check its storage, then retry." | **Retry**, after the owner fixes storage locally; show the existing connection failure surface |

A transient handshake failure uses the connection's existing backoff and reconnect state. Identity, storage and version failures stop automatic retries until their prerequisite changes. Do not reopen or re-enrol a healthy connection just to show the lock.

**Settings.**
- Workspace → Security: **"Require end-to-end encryption"**. Machines that can't are refused, through the same mechanism as "Require confirmed devices" (§6.8), with the same optional grace period. Off by default at first; on by default for new workspaces once most connectors have updated.
- Workspace → Security: **"Connection-level audit only"** (§8.9).
- Local Settings → Remote access: one row showing the machine's state (`auto`, `required`, `off`).

**What is deliberately absent:** a passphrase, a recovery key, key backup, a per-session switch, a "verify before first use" step.

**Claims.** Once L2 is the default:
> On an encrypted connection, session content is encrypted between your browser and the computer whose key it has accepted. The relay cannot decrypt that connection. If the key was accepted on first use, a relay compromised at that first use could impersonate the computer and read what you send to it; Verify lets you check the identity independently. The relay still sees who connects to which computer, when, how much data moves, and activity labels unless disabled. GitHub webhook deliveries pass through the relay as GitHub sends them.

Keep the pointers to §2.3 and §6.7: malicious frontend code and relay-substituted grantee keys are not solved by L2. Never claim universal protection from a malicious operator, “zero knowledge”, or independent verification for a first-use pin. Short product copy may say “End-to-end encrypted” only with the identity status and these limits accessible in the detail sheet/security documentation.

### 8.13 Cost and limits

- **Connect.** Across both endpoints: two ECDSA signatures and verifications, two ephemeral ECDH key generations, key derivation and durable policy/pin updates. One extra browser↔machine round trip, alongside `hello` when the pin already says the machine encrypts (§8.8). Measure rather than assume the storage/crypto cost.
  - Budget: time from socket open to first session frame grows by no more than one round trip plus 20 ms. Slice 9 measures cold connect, reconnect and phone resume separately, including the first durable transition. Healthy resume must not add a handshake or history replay. If the budget is missed, resolve it before default enablement rather than skipping persistence or authorization.
- **Per message.** AES-GCM runs at hundreds of megabytes per second in WebCrypto and Node. The existing per-frame signature stays the larger cost.
- **Size.** 16 bytes of tag, a small header, and base64 over the body.
  - REST bodies already use base64; L2 adds the sealed header, tag and envelope overhead without a second base64 pass.
  - Stream frames are JSON text inside JSON today; sealed, they grow by roughly a quarter.
  - Byte metering and the daily-bytes quota count wire bytes, so quota thresholds need re-basing when encryption becomes the default (`docs/RELAY-HARDENING.md` §6).
  - Binary WebSocket frames would remove the base64 cost. That is a later optimisation (§8.15), because the hub validates JSON envelopes today.
- **Large replays.** A long session's history arrives as many frames, each sealed separately. Nothing is buffered beyond what is buffered now.

### 8.14 Feature check

What the app does over the relay today, and what L2 changes for it:

| Feature | Path | Under L2 |
| --- | --- | --- |
| Chat, approvals, stop, permission modes, model and effort | Stream frames | Sealed. No change in behaviour |
| Session start: places, scratch folders, orgs, clone, attach | REST | Sealed |
| File upload | REST, up to 8 MiB | Sealed, one base64 pass |
| Changes panel, diffs, docs browser | Stream and REST | Sealed |
| Canvas items, charts, HTML, snapshots | Stream frames; rendered in the sandbox frame through `postMessage` | Sealed in transit. The sandbox origin is frontend code, so it falls under §2.3 and L3 |
| Canvas live preview | Not available through a relay (snapshots instead) | Unchanged |
| Automations, Deployments, Joe, Tasks, Settings, Webhooks settings | REST | Sealed |
| Sharing | Relay records, signed grants, connector checks | Grantees encrypt with a first-use pin (§8.6). Relay-side mirrors are skipped (§8.11) |
| "Session needs you" title count, notifications | Computed in the page from stream frames | Unchanged |
| GitHub webhooks through the relay | `webhook` principal, clear | Outside encryption (§9) |
| Confirm a browser, passkeys, revoke | `enrol_*` frames | Unchanged, clear by design |
| Desktop app, hosted web mode | Same web app in WKWebView | Same. WebCrypto there has ECDH, HKDF and AES-GCM |
| Local UI | Doesn't cross a relay | Unaffected |

**Rule for new features.** Anything that would have the relay read, store or produce session content (push notifications with text, an offline queue, a relay-side session list) needs §8.15's per-session keys first, or it breaks the claim.

### 8.15 Later

**Per-session content keys.** Needed only if the relay ever stores content.
1. Each enrolled device gets a static ECDH key next to its signing key, and the trust store records it. L2 as specified here doesn't create one.
2. The connector generates a random 256-bit key per session.
3. It wraps the key to each device's ECDH key (owner devices, plus grantee keys from grants) with ECDH-ES and HKDF, and publishes the wrapped keys through the relay.
4. Content stored on the relay is AES-GCM-sealed under the session key.
5. Revoking a device rotates the key for future content.

**Verified pins for passkey-added browsers, with no step.** WebAuthn's PRF extension lets a passkey produce a secret that syncs with it. A code-confirmed browser could use it to authenticate `kM` for the owner's other browsers, in the same Face ID that adds them. It depends on browser and provider support, so it is an upgrade to D8, not a replacement.

**Binary frames** for sealed payloads (§8.13).

---

## 9. Compatibility

- **Versions.** Capabilities negotiate transport support, never authority. L1 intents remain version 1; L2 handshake/content intents use signed version 2 (§8.5), which old enforcing connectors reject. New browsers keep signing version-1 traffic for L1-only connectors where cleartext is still permitted. Only pre-L1 machines lack intent support. A stored browser encryption requirement always overrides a claimed lack of support.
- **Self-hosted relays.** These work unchanged. `relayOrigin` and the passkey rpID come from the relay URL in `relay.json`.
- **Local UI.** It talks to the local server directly with the local token, not through the relay. It is unaffected.
- **Joe, loops and workflows.** These start on the machine and never cross the relay. They are unaffected.
- **GitHub webhooks forwarded by the relay** (`SELF-HOSTED-RELAY.md`, "GitHub webhooks") arrive as a `webhook` principal, not as user intents. GitHub's HMAC signature, checked on the machine, authenticates them. The connector lets them reach only the local webhook route and refuses replays. They need no device signature, and under L2 they stay outside end-to-end encryption because GitHub sends them in the clear.
- **Desktop app.** Its own local UI is unaffected. Its hosted web mode uses browser keys (§4.2).

**L2 version matrix.** Encryption needs all three parts and L1 enforcement. Clear rows below apply only when the browser has no remembered encryption requirement and neither machine nor workspace requires L2. Otherwise refuse; no automatic downgrade. L1 `off`/`warn` and local L2 `off` are explicit prerequisite failures with the corresponding status, not encrypted states.

| Relay | Web app | Connector | Result |
| --- | --- | --- | --- |
| carries sealed payloads | new | has `e2e` | Encrypted. The machine moves to `required` (§8.7) |
| carries sealed payloads | new | older | Clear, as today. "Update Codekin on this computer" in the detail sheet |
| carries sealed payloads | cached old page | has `e2e`, `auto` | Clear until the page reloads |
| carries sealed payloads | cached old page | has `e2e`, `required` | Refused with `e2e_required`: "Update the page" |
| older (self-hosted) | any | has `e2e`, `auto` | Clear, as today |
| older (self-hosted) | any | has `e2e`, `required` | Refused; the UI names the fix (§8.12) |

- **Deploy order.** Relay and webroot first, together, as passkey sign-in already requires (§6.6a). Then the connector release (npm and desktop). Machines start encrypting as they update, with no action from their owners.
- **Self-hosted relays** follow the same order. A relay that is never updated keeps working in clear.
- **Cached pages.** Ship handling for `e2e_required` and a generic reload/update fallback in the webroot before connector enforcement. A truly old page cannot display new copy retroactively: the relay must also surface a content-free reload refusal through its existing error/close path. Test that page version explicitly. Once a machine transitions, its old clear channels close (§8.7).
- **Rollback.** Keep sealed carriage and version-2 verification when rolling back unrelated changes. Do not roll a pinned machine/relay back to a version that cannot enforce these rules; restore compatible versions or use the local UI. The machine policy and browser pins are not reset by a rollback.

---

## 10. Implementation plan

Slices 1–7 describe completed L1 work. Each L2 slice is a documentation-planned PR with its own tests, behind `CODEKIN_RELAY_E2E=1` until slice 12's pre-default gate passes. This plan does not authorize starting implementation.

| # | Slice | Contents |
| --- | --- | --- |
| 1 | **Audit events** (§7.1) | Emit `prompt_sent`, `approval_answered`, `file_uploaded`, `session_stopped` (+ `session_created`, `permission_mode_changed`) from the hub, with relay-computed hashes; audit UI filters |
| 2 | **Machine identity + trust store** | `relay-identity.json`, `relay-devices.json`, `/api/relay/devices*` local routes, `codekin relay devices` CLI, Settings → Remote access → Devices (read-only list, revoke). No enforcement yet |
| 3 | **Enrolment ceremony** | `enrol_*` envelopes in the hub and connector; browser key generation (IndexedDB); trust sheet; code entry in local UI, desktop and CLI; pairing integration (§5.3); relay `device_keys` registry |
| 4 | **Intent signing + verification** | `intent-actions.ts`; signing in `relay-client.ts` / `hosted.ts` with ordered async queue; verification at the connector boundary; replay cache; `warn` mode; local intent log (§7.2) |
| 5 | **Passkeys** | Passkey enrolment in the ceremony; `device_certify` (user verification required, "added by passkey" notice, local "only devices confirmed here" switch); step-up for privileged actions with `stepUp` logged; "Privileged actions need a passkey" workspace setting; remote `device_revoke` |
| 6 | **Signed grants + grantee intents** | `grant` / `grant_revoke`; `signedGrants` in principal; intersection on the connector; grants dropped when their signing key is revoked; share-dialog device list; "new device" re-sign prompt; silent renewal capped by share expiry |
| 7 | **Enforce** | `required` for new pairings and on first enrolment; `intentPolicy` in `ConnectorHello`; "Require confirmed devices" workspace setting with optional grace; migration prompts; minimum connector version per capability; forged-principal negative suite on staging (§11) |
| 8 | **Protocol, crypto core, relay carriage** | Shared WebCrypto module and exact encodings/vectors (§8.3–8.4); handshake, sealed and label schemas; signed intent version 2 and unconditional binding checks (§8.5); legacy-verifier negative fixture. Hub carriage parses envelopes, never ciphertext. Nothing uses it yet |
| 9 | **Handshake + sealed streams** | Strict session identity/authorization; connector session table; ordered queues at both ends; atomic pin migration across every writer; first-use/grantee pins; healthy-resume preservation; recovery without replaying pending mutations. Flagged staging use only. Measure §8.13 |
| 10 | **Sealed REST** | Requests/responses and uploads; response binding, bounded queues and headers; nonce-preserving retries and unknown-outcome reconciliation; revocation during pending REST. Same flag |
| 11 | **Enforcement, audit + recovery UX** | Canonical audit labels, creation receipts, coalescing-aware `audit verify --against`; all four hub content paths adapted; durable `e2e` policy and teardown of clear traffic; signed raise-only policy operation; revocation; capability floor. Lock/detail sheet in Settings → Machines, owner/grantee Verify, actionable failures, local CLI/settings and workspace controls. Flag stays on; no default enablement |
| 12 | **Default rollout + claims** | Enable automatically only after the pre-default gate below, with compatibility handling already deployed. Remove the flag, re-base byte quotas, publish operational recovery docs. Publish security claims only after the post-default release gate; implementation and claims need not ship in the same release |

Slices 8–11 can merge independently behind the flag; public claims must continue to describe the released behavior.

**L2 gates.**
- **Before slice 12 turns it on by default:** the complete L2 suite of §11 passes on staging with two tenants; an independent review covers the final integrated slices 8–11, including authorization, revocation, retries, pins, audit and downgrade enforcement. Findings are resolved and security-relevant changes re-reviewed. Recovery UX, cached-page refusal handling, storage-failure handling and byte-quota adjustments are already available. Validate the final reviewed revision, not an earlier crypto-only build.
- **Before the claim in §8.12 is published:** the default has been on for a release without a protocol fix, and copy states first-use, grantee-key and frontend limits. A protocol fix restarts that observation period.

Normal users see no L2 behavior change until slice 12; flagged staging users exercise the complete UX before then. Routine connections still add no confirmation step.

---

## 11. Testing

**Attacker harness.** `server/relay/relay-adversary.test.ts` plays a malicious hub against a real connector and a stub local server. It asserts that each of these is refused:
- owner principal without an intent, with a tampered `payloadHash`, `action`, `machineId` or `sessionId`
- replayed nonce
- stale or future `ts`
- unknown, revoked or grantee key used for owner actions
- an intent for session A used on a channel joined to B
- REST path differing from the signed path (including percent-encoding variants)
- an `enrol_reveal` that doesn't match its commit, or a wrong code typed locally
- a fourth pending enrolment
- a passkey assertion with the wrong origin, rpID or challenge, or without user verification
- a fabricated grantee principal without a signed grant
- an expired or revoked grant
- a grantee frame signed by a key outside the grant
- a remote `policy` intent that lowers the policy
- a step-up action signed with a browser key when a passkey is enrolled

**Local-only routes.** A test asserts that `/api/relay/devices*` is unreachable through `checkProxyRequest` for every method.

**Browser.** Unit tests for signing order under concurrent sends; the clock-offset retry; IndexedDB loss leading to the trust sheet; the pinned machine key mismatch refusal (L2).

**L2.**
- **Canary.** Run a known plaintext through a full session (prompt, approval, upload, diff, Canvas item, settings change) and assert it never appears in bytes the hub receives, in relay logs, in audit rows or in error reports.
- **Vectors.** Fixed inputs for the transcript, key derivation, nonce and one sealed message of each kind, checked in Node and in a browser test run.
- **Adversary harness** (`relay-adversary.test.ts`), each refused:
  - a repeated or lower `seq`
  - a sealed frame moved to another channel, and a response paired with another request
  - a changed, added or removed label, and a label that disagrees with its intent
  - swapped ephemeral keys, and an `e2e_accept` signed by a key other than the pin
  - a replayed `e2e_init`
  - an intent taken out of a sealed frame and sent in clear, or into another encrypted session (§8.5)
  - a false first-use endpoint unwrapping a version-2 request into clear traffic to a pinned legacy L1 `required` verifier fixture; also prove that the old optional-field/version-1 construction would be accepted there
  - version-1 intents inside ciphertext, version-2 content intents in clear, missing session bindings, and handshake attempts under L1 `off`/`warn`
  - substitution of user, role or browser identity on an established encrypted session; expired/narrowed grants and revoked signers during a pending REST response
  - clear traffic to a machine at `required`, and a relay that stops announcing sealed carriage
  - output or a pending response on an old clear channel after the required-policy barrier; lost/corrupt policy storage and a concurrent stale trust-store writer
  - a remote request that lowers the `e2e` policy
  - unsigned, replayed or wrong-machine policy-raise acknowledgements
  - more encrypted sessions than the limits allow
- **Retries.** Execute a mutation, withhold its response, and inject `e2e_unknown`, `e2e_failed`, timeout and step-up errors. It must execute at most once across fresh handshakes, signer changes and connector restart. Cover same-nonce replay refusal, expired retry windows, unsent operations and unresolved outcomes. No reconnect replays a prompt, approval or create action as a new operation.
- **Pins.** Concurrent first-use connections with different keys; passkey recertification attempting replacement; same-key writes preserving verification and the required bit; storage failure before first content; another tab updating a pin; authenticated owner/grantee replacement. No reset-by-re-enrolment or silent fallback.
- **Audit.** Fixed canonical encodings; reordered envelope properties; invalid/missing/extraneous labels; false `detail`; conflicting mode hints; stream creation markers versus real ids across two channels; failed creation; missing receipts; coalescing, retries, retention and disabled labels producing honest comparison coverage.
- **Hub.** No ciphertext decoding/parsing; valid sealed streams pass with malformed-content abuse rules enabled, including disconnect actions. Malformed envelopes and byte/rate limits still work.
- **Lifecycle.** Connector restart mid-session, reconnect, healthy and dead phone resume, two tabs, queued crypto completing after retirement, revocation while streaming or awaiting REST, 24-hour refresh during a mutation, sequence exhaustion and boundary-sized uploads.
- **Budget.** Connect time and bytes on the wire against §8.13, recorded in the slice 9 PR.
- **Compatibility.** Every row of §9 with and without a remembered browser requirement; local L1/L2 overrides; cached pre-L2 pages; relay rollback; local lowering with the browser pin retained. Confirm the error gives a usable recovery action without bypassing encryption.

**Staging gate.** Run the suite above against two real tenants on staging, together with the existing cross-tenant suite.

**Manual.** Cover these paths:
- iPhone Safari (home-screen and tab): passkey certification and the 7-day eviction path
- Android Chrome
- desktop app web mode, browser key only
- headless Linux with CLI approval

---

## 12. Later: L3

This level targets a malicious operator and targeted key injection.
- A reproducible, signed build of the hosted frontend, with published hashes.
- The desktop app loading a bundled, signature-checked copy instead of the remote origin.
- A public, append-only transparency log of device-key and grant-key changes per user, which browsers and connectors check. It closes the grantee trust-on-first-use gap in §6.7 and the first-use pins in §8.6.

---

## 13. Decisions

D1–D7 were decided 2026-11-08. Each decision is written into the section it changes. D8–D13 came with revision 2 on 2026-11-15. D14–D16 and the implementation clarifications in revision 3 were accepted following the same day's spec audit. No decision authorizes implementation yet.

| # | Decision | Decided |
| --- | --- | --- |
| D1 | Sign reads too, or control frames only? | **Sign everything** except `ping` and `resize` (§2.2). Unsigned reads would let a compromised relay pull files and sessions itself. Codekin frames are chat-sized, so signing each costs under a millisecond |
| D2 | Step-up when the owner has no passkey enrolled on the machine | **Accept the browser key**, offer passkey enrolment at pairing, add an opt-in workspace setting "Privileged actions need a passkey", and log which kind of step-up each action had (§6.6). Not required by default, because the desktop web view can't use passkeys |
| D3 | Grant lifetime | **At most 30 days and never past the share's expiry**, re-signed silently while the owner is online. Changed key sets always need the owner. **Grants die when their signing key is revoked** (§6.7) |
| D4 | Under L2, may the relay see per-message action labels and session ids for audit? | **Yes**, with a per-workspace "Connection-level audit only" opt-out. The label's content tag is an **HMAC under a machine-held key**, not a plain hash, so short content can't be recovered by guessing (§8.9) *Amended by D10: the intent nonce replaces the HMAC tag.* |
| D5 | Allow passkey certification of new browsers (trusting the passkey provider's sync)? | **Yes**, with user verification required, "added by passkey" shown on the machine and announced to the owner's other devices, and a machine-local "Only allow devices confirmed on this computer" switch (§5.4) |
| D6 | Grantee machine-key pin | An **owner-signed `kM` fingerprint in the grant**, plus **pin on first use** in the grantee's browser, which refuses a changed key until the grantee confirms it (§8.6) *Amended by D8: the fingerprint is dropped, the first-use pin stays.* |
| D7 | Existing machines | **`required` for new pairings and on first enrolment.** The connector reports its policy; a workspace setting "Require confirmed devices" refuses other machines through the version-floor mechanism, with an optional grace period (§6.8) |
| D8 | Browsers that learned the machine key from the relay (added by passkey, and grantees): confirm on the machine before encrypting? | **No.** Encrypt at once with a first-use pin, say so in the detail sheet, offer Verify (§8.6). Amends §6.6a and drops D6's fingerprint in the grant, which a grantee can't check. Rejected: requiring the code first, which sends passkey-added phones back to the computer and leaves grantees without encryption |
| D9 | Handshake shape | **Two messages.** The signed `e2e:init` intent authenticates the browser; the first sealed frame confirms the keys (§8.3). No in-place rekey: the browser reopens its socket after 24 hours (§8.8) |
| D10 | What the audit label carries | **The intent nonce, no content-derived tag.** Removes `kAudit`. The label is authenticated and the machine checks it against the intent (§8.9). Amends D4, whose opt-out stays |
| D11 | Falling back to clear text | **Never silently.** A machine moves to `required` after its first encrypted connection and can be lowered only locally; the browser remembers too (§8.7) |
| D12 | Wire format | **Sealed payloads in the existing envelope kinds, base64 in JSON.** Bindings use the browser's channel id and the request's `seq`, not ids the hub rewrites (§8.4). Binary frames later |
| D13 | Defaults | **On automatically** wherever all three parts support it and L1 is enforced, with no common-path user setting. Deliberate local overrides retain their existing policy flow (§8.7). Workspace "Require end-to-end encryption" starts off by default (§8.12) |
| D14 | Can an optional version-1 `e2e` field stop unwrapping to legacy connectors? | **No. Use signed intent version 2** for L2 handshake/content, with mandatory session binding for content and strict rejection outside that session. Old L1 `required` verifiers reject the version; relay capability claims are not security evidence (§8.5) |
| D15 | Retry mutations after an encrypted connection fails? | **Never as a fresh operation automatically.** Preserve the operation nonce and bounded retry lifetime across handshakes. Reconcile unknown outcomes, preserve drafts, and do not equate replay refusal with success (§8.4) |
| D16 | Enable encryption before recovery UX and review of enforcement? | **No.** Slice 11 completes enforcement, audit and UX behind the flag. Slice 12 enables the default after integrated review/testing of slices 8–11. Claims wait a further release without a protocol fix (§10) |
