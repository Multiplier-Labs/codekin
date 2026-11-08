# Relay trust: device-signed intents and end-to-end encryption

**Status:** Spec, decisions D1–D7 settled (§13). Built: slice 1 (relay audit events, §7.1), slice 2 (machine identity and trust store), slice 3 (enrolment ceremony, §5.2–5.5), slice 4 (intent signing and verification, §6.1–6.5, §7.2) slice 5 (passkeys: enrolment, `device_certify`, step-up, remote `device_revoke`, §5.4, §5.6, §6.6) slice 6 (signed share grants and grantee intents, §6.7) and slice 7 (enforcement, §6.8): L1 is complete. L2 (slices 8–11) is not built.
**Date:** 2026-11-08
**Context:** a hosted relay is trusted to say who the machine owner is (§3). This spec removes that trust in two levels: **L1 device-signed intents** and **L2 end-to-end content encryption**. It also adds the relay audit events that are declared but never emitted.
**Basis:** `origin/main` at v0.10.5 (`a93f6e3`). All `path:line` references point there.
**Related:** `docs/HOSTED-RELAY-CONTROL-PLANE-SPEC.md` (§5 trust boundaries, §7 protocol, §14 open questions), `docs/DEVICE-LINK-AND-PASSKEY-SPEC.md`, `docs/HOSTED-SECURITY-AUDIT-2026-09-28.md`.

---

## 1. Summary

Today a connected machine does whatever the relay tells it to, as long as the relay labels the request `role: 'owner'`. Anyone who controls the relay can therefore drive every connected machine. That includes an attacker who has broken into it, an insider, or the operator. The relay also reads every prompt, response and tool call in clear text.

This spec fixes that in two stages.

**L1: signed intents.**
- Each browser the owner uses holds a private signing key that never leaves it.
- The machine keeps its own local list of the public keys allowed to control it.
- A key gets onto that list only through a confirmation done *on the machine*.
- Every frame and request the browser sends to the machine is signed. The connector checks the signature against the local list before anything reaches the local Codekin server.
- Share grants are signed by the owner. Grantees sign their own frames.

With L1 in place, the relay can still read traffic, delay it or drop it. It can't create, change, replay or redirect an action, and it can't grant itself access.

**Audit (ships first).** The relay starts recording the four declared-but-never-emitted events: `prompt_sent`, `approval_answered`, `file_uploaded` and `session_stopped`. These records hold no content: actor, machine, session, action, payload hash, signing key. The connector keeps its own hash-chained log of every intent it accepted or rejected. The owner can check the relay's audit against it.

**L2: end-to-end encryption.**
- Each browser↔machine connection runs an authenticated key exchange, using the device keys from L1 and a machine identity key that L1 introduces.
- Every stream frame and REST body is encrypted with AES-256-GCM.
- The relay keeps routing, rate limits and content-free audit metadata, and sees nothing else.
- Relay-side frame filtering for grantees moves fully to the connector, which already does the same checks.
- This spec uses per-connection keys rather than per-session wrapped keys. The relay stores no content, so there is nothing at rest to wrap keys for (§8.1).

---

## 2. Threat model

### 2.1 Actors

| Actor | Today (L0) | After L1 | After L2 |
| --- | --- | --- | --- |
| Another tenant | Blocked (grantee isolation, `isolation-audit.test.ts`) | Blocked | Blocked |
| A stolen relay session cookie | Full control of the victim's machines | Can't act: no device key. Can still read what the victim's browser is streaming | Can read nothing |
| Relay backend compromise, or an operator using relay access | Full control of every machine, reads everything | **Can't act, can't grant itself access.** Reads traffic in transit. Can delay or drop | Reads metadata only (who, which machine, when, sizes). Can delay or drop |
| Relay serving malicious web-app JavaScript | Full control | **Not defended.** The JS runs with the user's device key in the user's browser (§2.3) | Not defended |
| Someone with local access to the machine | Full control | Full control (out of scope) | Full control (out of scope) |

### 2.2 Properties L1 must guarantee

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
- **L2:** "Session content is end-to-end encrypted between your devices and your computer."

---

## 3. Current state (facts from code)

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
- **What:** one ECDSA P-256 key pair for signing. L2 adds one ECDH P-256 key pair.
- **Where:** `~/.config/codekin/relay-identity.json`, mode 0600, beside `relay.json`. The desktop app moves it into the macOS Keychain, the same as the planned move for the machine secret.
- **What it's for:**
  - The connector signs enrolment transcripts (§5.2), so the browser can tell it is talking to the real machine.
  - It authenticates the machine's side of the L2 handshake.
- **Registry:** the public key is sent to the relay on `pair/complete` and in `ConnectorHello`, so browsers can fetch it. The relay copy is only a hint. Browsers trust only the key they **pinned during enrolment** (§5.2).
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
- **The finishing code protects the browser's pin.** Without step 5, a relay could answer a browser's *first* enrolment as the machine: sign the challenge and the `enrol_result` with a key of its own, which the browser has no pin to check against. The machine is safe either way, because the code the browser shows is computed with the relay's key and won't match. But the browser would pin the relay's key, and L2 (§8.2) trusts that pin. The machine shows CC only after it accepted the code, so a relay that swapped `kM` never gets one shown to the user. Decided 2026-11-08 (option A on #818).
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
- **Registry.** When a machine accepts a reveal, the relay records the key in `device_keys` (`GET`/`DELETE /api/device-keys`).
- **Not built yet:** the desktop notification and tray item for a waiting request (§5.5), and the Account → Devices page (§6.9).

### 5.3 At pairing

Pairing already has the user at the machine and in the browser at the same moment.
1. Approving the pairing code in the browser starts the ceremony straight away.
2. The CLI or local UI that showed the pairing code then asks: "Type the code your browser shows to let it control this machine."
3. New pairings set `policy: "required"` once the first credential is enrolled.

The two steps finish together: the user types one code on the machine, and the machine is paired and trusts that browser.

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
| CLI | `codekin relay devices list \| approve <code> \| revoke <keyId> \| policy <off\|warn\|required>` | Edits the trust store file directly |

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
| `ws:create_session`, `rest:POST /api/sessions/create` | `session_created` (new) | when `permissionMode` is `bypassPermissions` |
| `ws:set_permission_mode` | `permission_mode_changed` (new) | to `bypassPermissions` |
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

**Privileged actions** are listed in §6.2: saving standing approval rules, bypass permission mode, shell-approving grants, and device and policy changes. If the owner has a passkey enrolled on the machine, these need a passkey assertion. The OS prompt ("Use Face ID to approve: Share session 'api-fix' with Dana, shell approvals") is the one thing a compromised page can't fake. The prompt text comes from the intent, so the connector sees the same action the user approved.

If the owner has no enrolled passkey, the browser key is accepted (D2 in §13). A passkey can't be required everywhere, because the desktop app's web view can't use passkeys (§4.2). Instead:
- The pairing flow offers passkey enrolment while the user is at the machine (§5.3).
- A workspace setting, **"Privileged actions need a passkey"** (default off), refuses browser-key step-up in that workspace. Workspaces turning it on should expect the desktop app's web mode to be unable to perform privileged actions.
- The machine-local intent log (§7.2) records the step-up as `stepUp: "browser-key"` or `"passkey"`, so the owner can see which actions had only the weaker confirmation.

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
    - L2 must treat it as unconfirmed, and ask for the confirmation code before trusting it for encryption.
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
  - Only the relay reports it. A lying relay can only leave the machine-side rule in force (a passkey enrolled here is always required).
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
- **Floor.** `CONNECTOR_FLOORS.capabilities.intents` is `0.10.6`, the release that carries this slice.
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
- Under L2 the relay can't parse frames. It audits from the intent's cleartext action label instead (§8.5).

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
- `codekin relay audit verify` checks the chain. With `--against <export>`, it compares the machine's log with the relay's audit export, so the owner can catch a relay that hides or invents actions.

---

## 8. End-to-end content encryption (L2)

### 8.1 Design choice: per-connection keys, not per-session wrapped keys

The audit suggested "per-session keys wrapped to enrolled devices". That design suits a server that **stores** ciphertext for devices to read later, as in messaging apps. The relay stores no content (§2.4). Everything it carries is live traffic between one browser socket and one connector. So:

- **Use:** an authenticated ephemeral key exchange per browser↔machine relay connection.
- **Why it's better here:**
  - forward secrecy
  - no key distribution or rotation across devices
  - no wrapped-key store on the relay
  - nothing breaks when a device is revoked
- **Add per-session content keys** only if a feature stores content on the relay: offline message queues, push notifications carrying text, synced transcripts. That design is sketched in §8.8 so it can be added later without a protocol break.

### 8.2 Handshake

The handshake runs once per `RelayConnection` (browser socket ↔ machine) and covers REST and every stream channel on it. It is a SIGMA-style exchange that uses the L1 keys:

```
B: eB ← ECDH P-256 ephemeral; nB ← 32 bytes
   e2e_init { keyId, eB_pub, nB, intent(action: 'e2e:init',
              payloadHash = SHA-256(eB_pub ‖ nB)) }               ──►
M: verify the intent like any L1 intent (key in trust store or grant, fresh, nonce unused)
   eM ← ECDH ephemeral; nM ← 32 bytes
   T = SHA-256("ck-e2e-v1" ‖ machineId ‖ keyId ‖ eB_pub ‖ nB ‖ eM_pub ‖ nM)
   e2e_accept { eM_pub, nM, sigM = sig_kM(T) }                     ◄──
B: verify sigM with the kM pinned at enrolment (§5.2); if it fails, close.
   e2e_confirm { sigB = sig_kB(T) }                                ──►
Both: ikm = ECDH(e_self, e_peer)
      k_b2m ‖ k_m2b = HKDF-SHA-256(ikm, salt = nB ‖ nM, info = "ck-e2e-v1" ‖ T, 64 bytes)
```

- `sigB` over `T` binds the browser's identity to this exact exchange. The `e2e_init` intent alone doesn't, because it is signed before `eM` exists.
- `sigM` uses the pinned key, so the relay can't sit in the middle.
- The browser keeps `kM` pinned in IndexedDB next to its own key. The relay's copy of the machine key isn't consulted.

**Grantees.** A grantee's key must be listed in an owner-signed grant (§6.7). The grantee has no pin for `kM`, so it trusts the relay's copy on first use. The relay could pretend to be the machine to a grantee and feed them fake content. It still couldn't read the owner's data, because it can't complete a handshake with the real machine without the grantee's key. **The grant carries a fingerprint of `kM`, signed by the owner, and the grantee's browser checks it** (D6). The grantee's browser also pins `kM` on first successful use and refuses a different key later, even in a newly signed grant, until the grantee confirms the change. A compromised owner browser therefore can't quietly swap the machine key for an existing grantee.

### 8.3 Frames

- **Envelope.** A new kind `sealed` replaces `stream_data` on E2E connections:
  `{ kind: 'sealed', channelId, payload: { seq, ct } }`.
- **Encryption.** AES-256-GCM with a 96-bit nonce built from a direction byte and `seq` as a uint64. `seq` must strictly increase for each direction and connection. The receiver rejects anything else, which covers replay, reordering and dropped-then-replayed frames.
- **Additional authenticated data:** `machineId ‖ channelId ‖ kind`. A frame can't be moved to another channel.
- **Plaintext:** the old `StreamData` (`{ data, intent? }`). Intents stay inside the ciphertext. Their job under L2 is the non-repudiable local log (§7.2) and step-up, not authenticity. The AEAD provides authenticity.
- **Rekeying:** a new handshake on reconnect, after 24 h, or after 2³² frames, whichever comes first.

### 8.4 REST

The `request` and `response` payloads become `{ sealed: { seq, ct } }`. The plaintext is the old `ProxyRequest` minus `principal`, or the old `ProxyResponse`. `id` and `principal` stay in clear: the relay needs them to route and to attach identity. The 8 MiB limit applies to plaintext. Encryption adds a 28-byte overhead per message.

### 8.5 What the relay still sees

- account, workspace, machine and channel ids, and connection times
- frame counts, sizes and timing
- `principal` (who is asking, and their relay-side grants)
- an **audit label** per sealed message: `{ action, sessionId, keyId, payloadTag }`, copied from the intent. This keeps §7.1 working under L2 (D4).
  - `payloadTag` is **not** a plain hash of the content. Short prompts ("yes", "continue") and approval answers could be recovered from a SHA-256 by guessing, which would quietly undo part of the encryption. It is `HMAC-SHA-256(kAudit, payload)`, where `kAudit` is a per-machine key in the machine's secret store, shared with enrolled owner devices at enrolment and never with the relay. The machine log (§7.2) records the same tag, so `codekin relay audit verify --against` still matches the two logs line by line.
  - A workspace setting, **"Connection-level audit only"**, drops labels entirely: the relay then audits connections, not actions.
  - Before L2 the relay sees plaintext anyway, and slice 1 stores a plain SHA-256 (§7.1). With L2 the label switches to the tag.
- enrolment and device metadata

### 8.6 Moving relay-side filtering to the connector

Two relay-side content checks stop working under L2:
- `isServerFrameVisible` in `browser-hub.ts:422`
- the grantee path check in `browser-hub.ts:352`

Both already run on the connector (`checkServerFrame`, `checkRestPolicy`). The relay repeats them only for older connectors that lack them. Plan:
1. Advertising `e2e` requires a connector version that includes those checks. Slice 10 sets that version as the floor for the `e2e` capability.
2. On E2E connections the hub skips content inspection and relies on the capability.
3. A test asserts that the hub never JSON-parses sealed payloads.

Grantee REST is still limited to `GRANTEE_ROUTES`. The connector enforces that after decrypting.

### 8.7 UX and claims

- A lock in the machine header shows "End-to-end encrypted". The detail sheet shows the machine key fingerprint and the browser key fingerprint.
- Machines without `e2e` show "Encrypted in transit; the relay can read content". A workspace setting, "Require end-to-end encryption", refuses such machines.
- Update the docs once L2 is on by default.

### 8.8 Later: per-session content keys

Needed only if the relay ever stores content.
1. The connector generates a random 256-bit key per session.
2. It wraps the key to each enrolled device's ECDH key (owner devices, plus grantee keys from grants) with ECDH-ES and HKDF.
3. It publishes the wrapped keys through the relay.
4. Content stored on the relay is AES-GCM-sealed under the session key.
5. Revoking a device rotates the key for future content.

L2 already supplies device ECDH keys and the trust store, so this needs no further enrolment work.

---

## 9. Compatibility

- **New fields.** Every addition is optional, and new behaviour is negotiated through `capabilities.intents` and `capabilities.e2e`. Old browsers talking to new connectors in `required` mode get `intent_required` and an "Update the page" notice. New browsers talking to old connectors sign nothing.
- **Self-hosted relays.** These work unchanged. `relayOrigin` and the passkey rpID come from the relay URL in `relay.json`.
- **Local UI.** It talks to the local server directly with the local token, not through the relay. It is unaffected.
- **Joe, loops and workflows.** These start on the machine and never cross the relay. They are unaffected.
- **GitHub webhooks forwarded by the relay** (`SELF-HOSTED-RELAY.md`, "GitHub webhooks") arrive as a `webhook` principal, not as user intents. GitHub's HMAC signature, checked on the machine, authenticates them. The connector lets them reach only the local webhook route and refuses replays. They need no device signature, and under L2 they stay outside end-to-end encryption because GitHub sends them in the clear.
- **Desktop app.** Its own local UI is unaffected. Its hosted web mode uses browser keys (§4.2).

---

## 10. Implementation plan

Each slice is one PR with its own tests, behind capability flags until slice 7.

| # | Slice | Contents |
| --- | --- | --- |
| 1 | **Audit events** (§7.1) | Emit `prompt_sent`, `approval_answered`, `file_uploaded`, `session_stopped` (+ `session_created`, `permission_mode_changed`) from the hub, with relay-computed hashes; audit UI filters |
| 2 | **Machine identity + trust store** | `relay-identity.json`, `relay-devices.json`, `/api/relay/devices*` local routes, `codekin relay devices` CLI, Settings → Remote access → Devices (read-only list, revoke). No enforcement yet |
| 3 | **Enrolment ceremony** | `enrol_*` envelopes in the hub and connector; browser key generation (IndexedDB); trust sheet; code entry in local UI, desktop and CLI; pairing integration (§5.3); relay `device_keys` registry |
| 4 | **Intent signing + verification** | `intent-actions.ts`; signing in `relay-client.ts` / `hosted.ts` with ordered async queue; verification at the connector boundary; replay cache; `warn` mode; local intent log (§7.2) |
| 5 | **Passkeys** | Passkey enrolment in the ceremony; `device_certify` (user verification required, "added by passkey" notice, local "only devices confirmed here" switch); step-up for privileged actions with `stepUp` logged; "Privileged actions need a passkey" workspace setting; remote `device_revoke` |
| 6 | **Signed grants + grantee intents** | `grant` / `grant_revoke`; `signedGrants` in principal; intersection on the connector; grants dropped when their signing key is revoked; share-dialog device list; "new device" re-sign prompt; silent renewal capped by share expiry |
| 7 | **Enforce** | `required` for new pairings and on first enrolment; `intentPolicy` in `ConnectorHello`; "Require confirmed devices" workspace setting with optional grace; migration prompts; minimum connector version per capability; forged-principal negative suite on staging (§11) |
| 8 | **E2E handshake + sealed streams** | §8.2–8.3 behind `e2e` capability; pinned machine key; rekey |
| 9 | **Sealed REST** | §8.4, including multipart uploads |
| 10 | **Relay goes blind** | Skip content inspection on E2E connections; minimum-version gate; audit labels with `payloadTag` (HMAC under `kAudit`) and the "Connection-level audit only" setting; grantee E2E with the `kM` pin |
| 11 | **UX + claims** | Lock indicator, fingerprints, workspace "require E2E", docs, security page |

Slice 1 doesn't depend on anything else and can merge right away.

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

**L2.** Run a known-plaintext canary through a full session (prompt, approval, upload, diff) and assert it never appears in bytes the hub sees. Also cover sequence replay and reordering, swapped ephemeral keys, a machine key that doesn't match the pin, and rekeying across reconnects.

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
- A public, append-only transparency log of device-key and grant-key changes per user, which browsers and connectors check. It closes the grantee trust-on-first-use gap in §6.7 and the first-use pin in §8.2.

---

## 13. Decisions

Decided 2026-11-08. Each decision is written into the section it changes.

| # | Decision | Decided |
| --- | --- | --- |
| D1 | Sign reads too, or control frames only? | **Sign everything** except `ping` and `resize` (§2.2). Unsigned reads would let a compromised relay pull files and sessions itself. Codekin frames are chat-sized, so signing each costs under a millisecond |
| D2 | Step-up when the owner has no passkey enrolled on the machine | **Accept the browser key**, offer passkey enrolment at pairing, add an opt-in workspace setting "Privileged actions need a passkey", and log which kind of step-up each action had (§6.6). Not required by default, because the desktop web view can't use passkeys |
| D3 | Grant lifetime | **At most 30 days and never past the share's expiry**, re-signed silently while the owner is online. Changed key sets always need the owner. **Grants die when their signing key is revoked** (§6.7) |
| D4 | Under L2, may the relay see per-message action labels and session ids for audit? | **Yes**, with a per-workspace "Connection-level audit only" opt-out. The label's content tag is an **HMAC under a machine-held key**, not a plain hash, so short content can't be recovered by guessing (§8.5) |
| D5 | Allow passkey certification of new browsers (trusting the passkey provider's sync)? | **Yes**, with user verification required, "added by passkey" shown on the machine and announced to the owner's other devices, and a machine-local "Only allow devices confirmed on this computer" switch (§5.4) |
| D6 | Grantee machine-key pin | An **owner-signed `kM` fingerprint in the grant**, plus **pin on first use** in the grantee's browser, which refuses a changed key until the grantee confirms it (§8.2) |
| D7 | Existing machines | **`required` for new pairings and on first enrolment.** The connector reports its policy; a workspace setting "Require confirmed devices" refuses other machines through the version-floor mechanism, with an optional grace period (§6.8) |
