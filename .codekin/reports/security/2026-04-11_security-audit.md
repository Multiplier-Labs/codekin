# Security Audit Report

**Repository:** codekin  
**Date:** 2026-04-11  
**Auditor:** Code Security Scanner  
**Scope:** Full codebase (backend server, frontend React app, configuration)

---

## Executive Summary

**Overall Risk Level:** MEDIUM

The Codekin repository demonstrates solid security practices with proper authentication, authorization, input validation, and XSS protection. However, several areas require attention to reduce potential attack surfaces, particularly around command injection prevention, stricter CORS configuration, and enhanced path traversal defenses.

### Key Findings

| Severity | Count | Categories |
|----------|-------|------------|
| HIGH | 0 | - |
| MEDIUM | 4 | Command injection, CORS misconfiguration, path validation, regex DoS |
| LOW | 6 | Error message exposure, logging gaps, type safety, rate limiting |
| INFO | 4 | Documentation, defense in depth |

---

## Detailed Findings

### MEDIUM-1: Command Injection via Unsanitized User Input

**Location:** `server/upload-routes.ts:282-286`, `server/webhook-workspace.ts`

**Description:**
While the `/api/clone` endpoint validates owner and name parameters with a regex, the validation does not fully prevent all potentially dangerous characters. The `gh repo clone` command is executed with user-provided input.

**Current Code:**
```typescript
const validName = /^[a-zA-Z0-9][\w.-]*$/
if (!validName.test(owner) || !validName.test(name) ||
    owner.toLowerCase() === '.git' || name.toLowerCase() === '.git') {
  res.status(400).json({ error: 'Invalid owner or repo name' })
  return
}
```

**Risk:**
- An attacker with valid authentication could potentially exploit edge cases in regex validation
- The regex allows dots (`.`) which could be used in directory traversal attempts

**Recommendation:**
1. Add explicit rejection of `..` sequences in owner/name
2. Consider using `execFile` with an array of arguments instead of string concatenation
3. Add a maximum length limit to prevent buffer-related issues

**Remediation:**
```typescript
// Add after existing validation
if (owner.includes('..') || name.includes('..')) {
  res.status(400).json({ error: 'Invalid owner or repo name' })
  return
}
// Add length validation
if (owner.length > 100 || name.length > 100) {
  res.status(400).json({ error: 'Owner or repo name too long' })
  return
}
```

---

### MEDIUM-2: Permissive CORS Default Configuration

**Location:** `server/config.ts:22`

**Description:**
The default CORS origin is set to `http://localhost:5173`, which is the Vite dev server. While there are checks to prevent this default in production, the configuration relies on environment variable presence rather than explicit opt-in.

**Current Code:**
```typescript
export const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173'
```

**Risk:**
- If `NODE_ENV` is not properly set to `production`, the server could run with permissive CORS
- The error handling exits the process, but this happens after the constant is already exported

**Recommendation:**
1. Require explicit CORS_ORIGIN in all non-development environments
2. Add validation that CORS_ORIGIN is a valid URL format
3. Consider allowing multiple origins via comma-separated list for multi-domain deployments

---

### MEDIUM-3: Path Traversal in File Upload Endpoint

**Location:** `server/upload-routes.ts:161-168`

**Description:**
The multer storage configuration sanitizes filenames but may not prevent all path traversal attempts. The regex replacement could potentially be bypassed.

**Current Code:**
```typescript
filename: (_req, file, cb) => {
  const ts = Date.now()
  const safe = file.originalname.slice(0, 64).replace(/[^a-zA-Z0-9._-]/g, '_')
  cb(null, `${ts}-${safe}`)
}
```

**Risk:**
- While the current implementation is reasonably safe, it relies on a single regex
- No explicit check for path traversal sequences like `../`

**Recommendation:**
1. Explicitly strip `..` sequences from the filename
2. Consider generating completely synthetic filenames (UUID-based) instead of user-provided names

---

### MEDIUM-4: Regular Expression Denial of Service (ReDoS)

**Location:** `server/crypto-utils.ts:13-24`

**Description:**
Several regex patterns in the secret redaction function use global matching with potentially complex alternations, which could lead to catastrophic backtracking on maliciously crafted input.

**Current Code:**
```typescript
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]'],
  [/Authorization:\s*[^\s"'\r\n]+/gi, 'Authorization: [REDACTED]'],
  [/(https?:\/\/[^:@\s]+):([^@\s]+)@/gi, '$1:[REDACTED]@'],
  [/\b(sk-|pk-|sk_live_|sk_test_|ghp_|gho_|ghs_|glpat-|xox[bpsa]-|api[_-]?key[=:]\s*)\S+/gi, '$1[REDACTED]'],
  [/(password|passwd|pwd|secret|token|credential|auth_token|access_key|private_key)[=:]\s*\S+/gi, '$1=[REDACTED]'],
]
```

**Risk:**
- Malicious input with nested quantifiers could cause exponential backtracking
- While this is in a logging context, it could affect server responsiveness

**Recommendation:**
1. Add input length limits before regex matching
2. Consider using non-backtracking regex engines or simplify patterns
3. Add timeouts for regex operations if possible

---

### LOW-1: Error Message Information Disclosure

**Location:** `server/ws-server.ts:641-648`

**Description:**
Uncaught exceptions and unhandled rejections are logged to console but may expose internal implementation details in stack traces.

**Current Code:**
```typescript
process.on('uncaughtException', (err) => {
  console.error(`[fatal] Uncaught exception at ${new Date().toISOString()}:`, err)
  console.error('[fatal] Stack:', err.stack)
})
```

**Risk:**
- Stack traces may reveal file paths, internal function names, and architecture
- In production, this could aid attackers in reconnaissance

**Recommendation:**
1. Sanitize stack traces before logging in production
2. Consider using a structured logging library that supports different log levels per environment
3. Send detailed errors to a monitoring service but log minimal info to console

---

### LOW-2: Insufficient WebSocket Message Rate Limiting

**Location:** `server/ws-server.ts:457-497`

**Description:**
The WebSocket message rate limiter uses a simple counter per connection but doesn't track burst patterns or implement exponential backoff for repeated violations.

**Current Code:**
```typescript
const MSG_RATE_LIMIT = 60
const MSG_RATE_WINDOW_MS = 1000
let msgCount = 0
let msgWindowStart = Date.now()
```

**Risk:**
- A client could send 60 messages at the exact start of each window
- No penalty for repeated rate limit violations

**Recommendation:**
1. Implement token bucket or sliding window algorithm for smoother rate limiting
2. Add progressive penalties (temporary disconnection) for repeated violations
3. Consider different limits for different message types

---

### LOW-3: Missing Content Security Policy for Development

**Location:** `server/ws-server.ts:290-299`

**Description:**
The CSP headers are set but include `'unsafe-inline'` for styles, which reduces protection against certain XSS vectors.

**Current Code:**
```typescript
res.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; ...")
```
**Risk:**
- `'unsafe-inline'` allows inline styles, which can be exploited for data exfiltration
- In production, this is somewhat mitigated by other headers

**Recommendation:**
1. Generate nonce-based CSP for inline styles if possible
2. Move inline styles to external CSS files
3. Document the trade-off and justification for using `'unsafe-inline'`

---

### LOW-4: Session Token Derivation Without Key Rotation

**Location:** `server/crypto-utils.ts:59-74`

**Description:**
Session tokens are derived using HMAC-SHA256 with the master token as the key. While secure, there's no mechanism for key rotation.

**Current Code:**
```typescript
export function deriveSessionToken(masterToken: string, sessionId: string): string {
  return crypto
    .createHmac('sha256', masterToken)
    .update(`session:${sessionId}`)
    .digest('hex')
}
```

**Risk:**
- If master token is compromised, all session tokens are compromised
- No built-in expiration mechanism for derived tokens

**Recommendation:**
1. Document key rotation procedures
2. Consider adding timestamp-based expiration to session tokens
3. Implement token versioning for emergency revocation

---

### LOW-5: SQL Injection Risk in Workflow Engine

**Location:** `server/workflow-engine.ts:224-238`

**Description:**
The workflow engine uses parameterized queries in most places, but the query builder uses string interpolation for column names and ORDER BY clauses.

**Current Code:**
```typescript
if (opts.orderBy) sql += ` ORDER BY ${opts.orderBy}`
```

**Risk:**
- While `orderBy` is controlled by internal code, this pattern could be accidentally misused
- Column names are not validated against a whitelist

**Recommendation:**
1. Validate `orderBy` against a whitelist of allowed columns
2. Use a query builder library that handles this safely
3. Add comments warning about this limitation

---

### LOW-6: Missing Brute Force Protection for WebSocket Auth

**Location:** `server/ws-server.ts:471-486`

**Description:**
The WebSocket authentication endpoint doesn't implement progressive delays or account lockout for failed authentication attempts.

**Current Code:**
```typescript
if (msg.type !== 'auth' || !verifyToken(msg.token)) {
  clearTimeout(authTimeout)
  ws.close(4001, 'Unauthorized')
  return
}
```

**Risk:**
- An attacker could rapidly attempt many tokens without penalty
- No IP-based tracking of failed auth attempts

**Recommendation:**
1. Add per-IP tracking of failed WebSocket auth attempts
2. Implement progressive delays after repeated failures
3. Consider temporary IP bans for excessive failed attempts

---

### INFO-1: Good Security Practice - XSS Protection

**Location:** `src/components/MarkdownRenderer.tsx`, `src/components/ChatView.tsx`

**Description:**
The application properly uses DOMPurify to sanitize HTML content before rendering, preventing XSS attacks.

**Positive Code:**
```typescript
const html = useMemo(
  () => DOMPurify.sanitize(marked.parse(content, { gfm: true }) as string),
  [content],
)
```

**Status:** No action required. This is a positive finding.

---

### INFO-2: Good Security Practice - Timing-Safe Comparison

**Location:** `server/crypto-utils.ts:42-50`

**Description:**
HMAC signature verification uses `crypto.timingSafeEqual` to prevent timing oracle attacks.

**Positive Code:**
```typescript
if (signature.length !== expected.length) return false
return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
```

**Status:** No action required. This is a positive finding.

---

### INFO-3: Good Security Practice - SSRF Protection

**Location:** `server/stepflow-handler.ts:406-440`

**Description:**
The Stepflow handler implements comprehensive SSRF protection by validating callback URLs against an allowlist and blocking private IP ranges.

**Positive Code:**
```typescript
// SSRF protection: validate callback URL against allowlist
const parsedUrl = new URL(callbackUrl)
if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
  throw new Error(`Callback URL protocol ${parsedUrl.protocol} not allowed`)
}
// Block private/link-local IP ranges
```

**Status:** No action required. This is a positive finding.

---

### INFO-4: Good Security Practice - Secret Redaction

**Location:** `server/crypto-utils.ts:13-32`

**Description:**
The application implements comprehensive secret redaction for logging, protecting sensitive credentials from accidental exposure.

**Status:** No action required. This is a positive finding.

---

## Dependencies Security

### Known Vulnerabilities

| Package | Version | Issue | Severity |
|---------|---------|-------|----------|
| better-sqlite3 | ^12.6.2 | None known | - |
| express | ^5.1.0 | None known | - |
| multer | ^2.0.0 | None known | - |
| ws | ^8.18.0 | None known | - |
| dompurify | ^3.3.2 | None known | - |

### Dependency Recommendations

1. **Enable Dependabot or Snyk** for automated vulnerability scanning
2. **Pin exact versions** in production deployments
3. **Regular audits** with `npm audit`

---

## Compliance Checklist

| Control | Status | Notes |
|---------|--------|-------|
| Authentication | PASS | Bearer token with SHA-256 verification |
| Authorization | PASS | Token-based access control |
| Input Validation | PARTIAL | Most endpoints validated, some edge cases |
| Output Encoding | PASS | DOMPurify for HTML, proper JSON |
| CSRF Protection | N/A | API uses token auth, not cookie-based |
| Rate Limiting | PARTIAL | Present but could be enhanced |
| Secure Headers | PASS | CSP, HSTS, X-Frame-Options |
| Error Handling | PARTIAL | Stack traces may leak info |
| Logging | PASS | Secrets redacted |
| Cryptography | PASS | HMAC-SHA256, timing-safe comparison |

---

## Recommendations Summary

### Immediate (High Priority)

1. Add `..` sequence validation to repository owner/name parameters
2. Implement explicit CORS origin validation with URL format checking
3. Add input length limits to regex-based secret redaction

### Short-term (Medium Priority)

1. Sanitize stack traces in production error logging
2. Enhance WebSocket rate limiting with progressive penalties
3. Validate ORDER BY columns against whitelist in workflow engine

### Long-term (Low Priority)

1. Implement token versioning for emergency revocation
2. Add per-IP tracking for WebSocket auth failures
3. Consider nonce-based CSP instead of `unsafe-inline`

---

## Appendix: Testing Recommendations

1. **Penetration Testing:** Focus on path traversal in upload and clone endpoints
2. **Fuzz Testing:** Target regex patterns with ReDoS payloads
3. **SAST:** Integrate static analysis into CI pipeline
4. **DAST:** Run dynamic scans against staging environment

---

*Report generated by automated security analysis. Manual review recommended for high-impact findings.*
