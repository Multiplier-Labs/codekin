# Relay L2 specification audit

**Date:** 2026-11-15  
**Scope:** Revision 2 of `docs/RELAY-SIGNED-INTENTS-AND-E2E-SPEC.md`, checked against the existing L1 verifier, relay hubs, browser transport, trust storage, audit implementation and hosted UI. This reviews the planned public protocol, not a hosted deployment.  
**Result:** Findings addressed in specification revision 3. L2 is not implemented; implementation and its independent security review remain outstanding and separately authorized.

| Finding | Evidence / consequence | Revision-3 resolution |
| --- | --- | --- |
| Optional session binding is not rejected by legacy verifiers | `intent-verify.ts` accepts version-1 intent bodies with unknown fields. A false first-use endpoint could unwrap such signatures into clear legacy requests | §8.5 / D14 requires signed version 2 for L2; legacy L1 `required` rejects it. Version and session checks are unconditional on new connectors |
| A lost reply does not establish non-execution | Clear errors are forgeable; existing REST retries preserve the nonce specifically to prevent duplicate execution | §8.4 / D15 retains operation identity across handshakes, bounds retry lifetime and reconciles unknown outcomes without fresh mutation nonces |
| Existing first-use pins can be overwritten | `certifyWithPasskey` permits replacement of `via: 'passkey'` pins | §8.6 requires migration of every pin writer, atomic first-use selection, persistent encryption requirements and authenticated replacement |
| Required-policy transition leaves existing traffic ambiguous | Existing clear channels and in-flight REST could still return content; lowering machine policy does not reset browser requirements | §8.7 defines a durable transition barrier, closes clear streams, suppresses late clear responses, handles storage failures and specifies recovery without browser downgrade |
| Enforcement precedes recovery UI and complete review | Revision 2 enables the default in slice 11, adds UX in 12 and reviews only 8–10 | §10 / D16 completes flagged enforcement and UX in 11; 12 waits for integrated review and staging of 8–11 |
| A fourth relay content inspector was omitted | `connector-hub.ts` calls `isWellFormedStreamData` for abuse detection; ciphertext lacks the clear `data` field | §8.11 separates envelope checks from clear-content classification and tests enabled enforcement rules |
| Audit schema and reconciliation are incomplete | Creation label lacks required fields; stream intents can use `@created:N`; coalescing loses individual nonces; current CLI lacks `--against` | §8.9 defines request/result labels, canonical encoding, scoped creation receipts and explicit incomplete-coverage results |
| UX and security copy diverge from the app and threat model | No hosted machine header; healthy `resume()` retains its socket; grantees lack local access; fake endpoints can fabricate content | §8.6 / §8.8 / §8.12 use Settings → Machines, preserve healthy resume, provide owner-assisted fingerprint verification and state first-use/grantee/frontend limits |

## Validation

- Compared the final protocol and rollout dependencies with the current source paths named above.
- Ran an isolated temporary fixture using the existing `IntentVerifier`, generated test keys and a temporary `required` trust store. A correctly signed clear version-1 request containing `e2e` returned `forward: true, verdict: accepted`; the corresponding version-2 request returned `forward: false, verdict: rejected, reason: intent_malformed`. No live machine, account or relay was contacted by the fixture. This checks the legacy rejection premise, not an unimplemented end-to-end L2 exchange.
- Added planned regression coverage in §11 for each finding, plus concurrent crypto queues, pin/policy persistence, pending-response revocation, byte limits, cached pages and rollback.
- Repository changes are documentation only. Runtime L2 tests cannot pass or fail this design yet; the implementation gate remains explicit.

## Remaining gates

The implementation needs a separate go-ahead. Before default enablement, test the complete implementation on staging with two tenants, complete independent review of slices 8–11 and resolve its findings. Publish claims only after a release with the default enabled and no protocol fix. No additional confirmation step is introduced on the normal L1-protected connection path.

## Final pre-implementation pass (revision 4)

A second pass over revision 3 compared the L2 sections again with the browser trust code (`src/hosted/deviceTrust.ts`, `intentSigner.ts`, `TrustSheet.tsx`) and the relay hub (`server/relay/browser-hub.ts`). It found no architectural problems: the protocol, handshake, version-2 binding, retry contract, audit labels and slice plan stand. It closed these gaps:

| Finding | Evidence / consequence | Revision-4 resolution |
| --- | --- | --- |
| First-use pins can't correct the clock | `verifyMachineTime` refuses pins with `via: 'passkey'`, but §8.3 relied on a signed-time retry. Every grantee and passkey-added browser with a skewed clock could never connect | D17: for version-2 intents only, a signed time from any pin is accepted, with a separate offset; version-1 signing, grant issue times and the clock probe still need a verified pin |
| One click undoes the encryption requirement | The trust sheet's "Forget the old key and start again" and `removeFromMachine` delete the pin; passkey certification could then fill a first use with the relay's key | §8.6: the forget-key action goes for pins carrying the requirement, replaced by Confirm replacement; remote removal marks the pin removed instead of deleting it |
| Grantee pins described as existing | Grantees sign without any pin today | §8.6 says L2 creates them, from the listed identity key, pinned by the first verified `e2e_accept` |
| "Fingerprint checked" had no provenance | L1 acknowledgement checks test `via !== 'passkey'`; a third state was undefined, and a "they match" click contradicts §5.2 | §8.6: the user types a 16-character, 80-bit verification code; stored as `via: 'fingerprint'`, equivalent to `via: 'code'` |
| "Require end-to-end encryption" had no input | The connector reported no L2 mode, and "machines that can't" was undefined | §8.7 adds the `e2ePolicy` report; §8.12 defines pass criteria and clear-envelope refusal, as an honest-relay control |
| Early handshake on an older relay | An older hub answers `hello_ack`, then closes with 1008 on the unknown `e2e_init`; a browser could loop on reconnect | §8.7: a `hello_ack` without sealed carriage is the relay-version failure, with no backoff loop |
| Shared sequence assumes hub ordering | REST and streams share one counter; an honest reorder would end the session | §8.4 makes per-socket arrival order a hub invariant (true today) with a test |
| Passkey operations after re-handshake | Version-2 intents bind the session, so a resent passkey-signed operation needs a new assertion | §8.4: re-sign inside a covering passkey window, else prompt again only for an operation the user is waiting on |
| Editorial | Missing commas in the status line; §6.8 pointed at the removed machine header | Fixed |

None of these adds a step to the normal connection path. With them, the specification is ready to plan slice 8 from; the go-ahead to implement remains separate.
