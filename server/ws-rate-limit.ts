/**
 * Per-connection message rate limiter for the WebSocket server.
 *
 * The counter is incremented for *every* observed frame, before any
 * JSON parsing. This prevents a flood of malformed (unparseable) frames
 * from bypassing the limit.
 */

export interface RateLimitDecision {
  /** True if the frame is within the limit and may be processed. */
  allowed: boolean
  /** True only on the first frame that exceeds the limit (used to send a single warning). */
  firstOverflow: boolean
  /** True once the client is sustaining traffic well beyond the limit and should be disconnected. */
  shouldDisconnect: boolean
}

export interface MessageRateLimiter {
  observe(): RateLimitDecision
}

export function createMessageRateLimiter(
  limit = 60,
  windowMs = 1000,
  now: () => number = () => Date.now(),
): MessageRateLimiter {
  let count = 0
  let windowStart = now()
  return {
    observe(): RateLimitDecision {
      const t = now()
      if (t - windowStart > windowMs) {
        count = 0
        windowStart = t
      }
      count++
      if (count > limit) {
        return {
          allowed: false,
          firstOverflow: count === limit + 1,
          shouldDisconnect: count > limit * 2,
        }
      }
      return { allowed: true, firstOverflow: false, shouldDisconnect: false }
    },
  }
}
