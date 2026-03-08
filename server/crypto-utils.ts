/**
 * Shared cryptographic utilities for webhook signature verification.
 */

import crypto from 'crypto'

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
