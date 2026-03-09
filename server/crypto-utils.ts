/**
 * Shared cryptographic utilities for webhook signature verification,
 * session-scoped token derivation, and secret redaction.
 */

import crypto from 'crypto'

/**
 * Redact potential secrets from a string before logging.
 * Matches common patterns: Bearer tokens, Authorization headers,
 * URL-embedded passwords, and common API key formats.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+\S+/gi, 'Bearer [REDACTED]'],
  [/Authorization:\s*\S+/gi, 'Authorization: [REDACTED]'],
  [/(https?:\/\/[^:]+):([^@]+)@/gi, '$1:[REDACTED]@'],
  [/\b(sk-|pk-|api[_-]?key[=:]\s*)\S+/gi, '$1[REDACTED]'],
  [/(password|passwd|pwd|secret|token)[=:]\s*\S+/gi, '$1=[REDACTED]'],
]

export function redactSecrets(input: string): string {
  let result = input
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement)
  }
  return result
}

/**
 * Verify an HMAC-SHA256 signature over a payload.
 * Comparison uses timingSafeEqual to resist timing oracle attacks.
 * Signature format: `sha256=<hex>` (GitHub/Stepflow convention).
 *
 * Returns false if the signature or expected lengths differ,
 * preventing timing leaks from the comparison itself.
 */
export function verifyHmacSignature(payload: Buffer, signature: string, secret: string): boolean {
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex')

  if (signature.length !== expected.length) return false
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
}

/**
 * Derive a session-scoped token from the master auth token.
 * Uses HMAC-SHA256(masterToken, "session:" + sessionId) so that:
 * - Each session gets a unique, unpredictable token
 * - The token cannot be used to recover the master token
 * - The server can verify it without storing extra state
 */
export function deriveSessionToken(masterToken: string, sessionId: string): string {
  return crypto
    .createHmac('sha256', masterToken)
    .update(`session:${sessionId}`)
    .digest('hex')
}

/**
 * Verify a session-scoped token against the master token and session ID.
 * Uses timing-safe comparison.
 */
export function verifySessionToken(masterToken: string, sessionId: string, candidateToken: string): boolean {
  const expected = deriveSessionToken(masterToken, sessionId)
  if (candidateToken.length !== expected.length) return false
  return crypto.timingSafeEqual(Buffer.from(candidateToken), Buffer.from(expected))
}
