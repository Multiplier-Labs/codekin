# Security Audit Triage — 2026-08-05

Triage of an external security audit (Codex) against the code on `main` at
`13940a0`. Each finding was verified in source before being accepted, deferred,
or rejected.

## Summary

| # | Finding | Audit severity | Verified | Disposition |
|---|---------|----------------|----------|-------------|
| 1 | Arbitrary file read via `[Attached files: …]` prefix | High | Yes | **Fixed** |
| 2 | Vulnerable Multer version (DoS) | High | No — stale | **Rejected** |
| 3 | Webhook config written without restrictive mode | Medium | Yes | **Fixed** |
| 4 | Master token in URL query string / localStorage | Medium | Yes | **Deferred** |

## 1. Arbitrary file read via attachment prefix — Fixed

**Verified** at `server/opencode-process.ts:1620` and `server/codex-process.ts:730`.
Both handlers matched the `[Attached files: …]` prefix on any inbound message and
read the named paths with no containment check.

**Severity assessment.** The audit rates this High on the basis that an
authenticated caller can exfiltrate local secrets. That overstates the delta:
Codekin's purpose is to give an authenticated user a coding agent with shell
access, so such a user can already read those files through the agent. The
finding is still worth fixing for two narrower reasons:

- It **bypasses the tool-approval flow**. The server reads the file and ships its
  contents to the provider with no approval prompt, whereas an agent-initiated
  file read can be gated.
- It is **latent injection surface**. Webhook-built prompts
  (`server/webhook-prompt.ts`) currently start with a fixed literal string and
  the regex is `^`-anchored, so externally-controlled content (PR titles, CI
  logs) cannot reach the prefix today. That safety is incidental — any future
  sender that places external text first would silently open the path.

**Fix.** Added `server/attachment-paths.ts`, which resolves each candidate with
`realpathSync()` and requires it to be a strict descendant of `SCREENSHOTS_DIR`.
Both handlers now reject anything else and log the rejection. The audit's
proposed remediation — replacing the text protocol with server-issued upload IDs
— was not adopted; containment achieves the same guarantee without a protocol
migration across client and both providers.

The check rejects paths outside the upload directory, symlinks escaping it,
`..` traversal, the upload directory itself, and sibling directories sharing its
name prefix. Claude sessions are unaffected: `claude-process.ts` does not parse
the prefix, and the CLI reads files under its own permission model.

**Tests.** 13 regression tests across `server/attachment-paths.test.ts`,
`server/codex-process.test.ts`, and `server/opencode-process.test.ts`. All 13
were confirmed to fail against a stubbed pass-through resolver, so they exercise
the containment check rather than passing vacuously. Positive-path tests confirm
legitimate uploads are still read.

## 2. Multer DoS — Rejected (stale finding)

The audit reports multer locked at 2.1.1 and cites GHSA-72gw-mp4g-v24j and
GHSA-3p4h-7m6x-2hcm. Both lockfiles in this repo pin **2.2.0**
(`package-lock.json:5996`, `server/package-lock.json:2362`), and both
`npm audit` and `npm audit --omit=dev` report **0 vulnerabilities**. The scan
appears to have run against an older checkout.

No change made. The audit's related CI recommendation is already satisfied:
`.github/workflows/ci.yml` runs `npm audit --audit-level=high` for the root and
server packages, which is stricter than the production-only audit suggested.

Follow-up: confirm the deployed clone carries the 2.2.0 lockfile.

## 3. Webhook config file mode — Fixed

**Verified** at `server/webhook-config.ts:112`. `saveWebhookConfig()` wrote the
temp file with no explicit mode; since `rename` preserves the source mode, the
resulting config — which may hold the GitHub webhook secret — was
umask-dependent. `server/commit-event-hooks.ts:55` already uses `0o600`, so this
was an internal inconsistency.

**Fix.** The temp file is written with `{ encoding: 'utf-8', mode: 0o600 }` and
`chmodSync(CONFIG_FILE, 0o600)` runs after the rename, which also repairs files
left permissive by earlier versions. Expected permissions are now documented in
`docs/GITHUB-WEBHOOKS-SPEC.md`, along with rotation guidance.

**Tests.** `server/webhook-config-save.test.ts` covers creation mode, repair of
an existing `0644` file, absence of a leftover temp file, and merge semantics.

**Rotation.** Warranted only if the host has other local users; on a
single-user host the prior exposure is moot.

## 4. Token in URL and localStorage — Deferred

**Verified** at `bin/codekin.mjs:99` and `src/hooks/useSettings.ts:31`. The
exposure described is real: the token survives in terminal scrollback, browser
history prior to the `replaceState` strip, and copied URLs.

Deferred rather than fixed. Two factors reduce urgency — the printed URL is
`http://localhost:…`, and the production deployment sits behind Authelia, so the
token is not the only gate there. The proposed remedy (pairing code or callback
exchange) is a feature-sized change to the CLI, the frontend bootstrap, and the
token model, not a patch appropriate to bundle with these fixes.

A cheap interim hardening exists if wanted: an option to print the URL without
the token, since the settings UI already accepts manual token entry.

## Not adopted

- **Upload-ID protocol redesign** — superseded by realpath containment.
- **Webhook secret rotation** — conditional on a multi-user host; see above.

## Verification

`npm run lint` (0 errors), `npm run build`, and `npm test` (2542 tests across
104 files) all pass on the branch.
