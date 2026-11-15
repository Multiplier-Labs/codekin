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
