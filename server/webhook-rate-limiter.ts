import type { RequestHandler } from 'express'

/**
 * Creates a per-key sliding window rate limiter for webhook requests.
 *
 * The `keyExtractor` determines which dimension to rate-limit on.
 * The default extracts `repository.full_name` from a GitHub webhook body,
 * but callers can pass a custom extractor for other payload shapes.
 *
 * The request body is expected to be a raw Buffer (from `express.raw()`).
 * Requests without an extractable key are allowed through — the signature
 * check downstream will reject invalid payloads.
 *
 * Example — GitHub webhook (default):
 * ```typescript
 * app.post('/api/webhooks/github', express.raw(...), createWebhookRateLimiter(), ...)
 * ```
 *
 * Example — Stepflow webhook, rate-limited by workflow kind:
 * ```typescript
 * app.post(
 *   '/api/webhooks/stepflow',
 *   express.raw(...),
 *   createWebhookRateLimiter(30, body => (body as any)?.event?.kind),
 *   ...
 * )
 * ```
 */
export function createWebhookRateLimiter(
  maxPerMinute = 30,
  /** Extract a rate-limit key from the parsed body.  Return `undefined` to skip limiting. */
  keyExtractor: (body: unknown) => string | undefined = (body) =>
    (body as { repository?: { full_name?: string } } | undefined)?.repository?.full_name,
): RequestHandler {
  const keyTimestamps = new Map<string, number[]>()

  // Periodic cleanup: every 5 minutes, remove keys with no recent timestamps
  const cleanupInterval = setInterval(() => {
    const now = Date.now()
    for (const [key, timestamps] of keyTimestamps) {
      const recent = timestamps.filter(t => now - t < 60_000)
      if (recent.length === 0) {
        keyTimestamps.delete(key)
      } else {
        keyTimestamps.set(key, recent)
      }
    }
  }, 5 * 60 * 1000)

  // Allow the process to exit without waiting for the interval
  if (cleanupInterval.unref) {
    cleanupInterval.unref()
  }

  return (req, res, next) => {
    let key: string | undefined

    try {
      const body = req.body
      if (Buffer.isBuffer(body)) {
        const parsed = JSON.parse(body.toString('utf-8'))
        key = keyExtractor(parsed)
      }
    } catch {
      // Malformed body — allow through (signature check will reject later)
    }

    if (!key) {
      next()
      return
    }

    const now = Date.now()
    const timestamps = keyTimestamps.get(key) ?? []

    // Prune timestamps older than 60 seconds
    const recent = timestamps.filter(t => now - t < 60_000)

    if (recent.length >= maxPerMinute) {
      keyTimestamps.set(key, recent)
      res.status(429).json({ error: 'Too Many Requests', repo: key, retryAfter: 60 })
      return
    }

    recent.push(now)
    keyTimestamps.set(key, recent)
    next()
  }
}
