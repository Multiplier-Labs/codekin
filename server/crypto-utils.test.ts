/** Tests for crypto-utils — verifies HMAC session-token derivation/verification and secret-redaction logic; no mocks (pure crypto operations). */
import { describe, it, expect } from 'vitest'
import {
  redactSecrets,
  verifyHmacSignature,
  deriveSessionToken,
  verifySessionToken,
} from './crypto-utils.js'
import crypto from 'crypto'

describe('crypto-utils', () => {
  describe('deriveSessionToken', () => {
    it('returns a consistent hex string for the same inputs', () => {
      const token1 = deriveSessionToken('master-secret', 'session-abc')
      const token2 = deriveSessionToken('master-secret', 'session-abc')
      expect(token1).toBe(token2)
      // SHA-256 hex digest is 64 characters
      expect(token1).toMatch(/^[0-9a-f]{64}$/)
    })

    it('returns different tokens for different master tokens', () => {
      const token1 = deriveSessionToken('master-A', 'session-1')
      const token2 = deriveSessionToken('master-B', 'session-1')
      expect(token1).not.toBe(token2)
    })

    it('returns different tokens for different session IDs', () => {
      const token1 = deriveSessionToken('master-A', 'session-1')
      const token2 = deriveSessionToken('master-A', 'session-2')
      expect(token1).not.toBe(token2)
    })
  })

  describe('verifySessionToken', () => {
    const master = 'test-master-token'
    const sessionId = 'sess-42'

    it('returns true for a correctly derived token', () => {
      const token = deriveSessionToken(master, sessionId)
      expect(verifySessionToken(master, sessionId, token)).toBe(true)
    })

    it('returns false when candidate is mutated by one byte', () => {
      const token = deriveSessionToken(master, sessionId)
      // Flip the first character
      const mutated = (token[0] === 'a' ? 'b' : 'a') + token.slice(1)
      expect(verifySessionToken(master, sessionId, mutated)).toBe(false)
    })

    it('returns false for wrong-length candidate (length-check short-circuit)', () => {
      const token = deriveSessionToken(master, sessionId)
      // Too short
      expect(verifySessionToken(master, sessionId, token.slice(0, 32))).toBe(false)
      // Too long
      expect(verifySessionToken(master, sessionId, token + 'ff')).toBe(false)
    })

    it('returns false for empty candidate', () => {
      expect(verifySessionToken(master, sessionId, '')).toBe(false)
    })

    it('returns false when master token differs', () => {
      const token = deriveSessionToken(master, sessionId)
      expect(verifySessionToken('wrong-master', sessionId, token)).toBe(false)
    })
  })

  describe('verifyHmacSignature', () => {
    const secret = 'webhook-secret'
    const payload = Buffer.from('{"action":"opened"}')

    function computeSignature(data: Buffer, key: string): string {
      return 'sha256=' + crypto.createHmac('sha256', key).update(data).digest('hex')
    }

    it('returns true for a valid signature', () => {
      const sig = computeSignature(payload, secret)
      expect(verifyHmacSignature(payload, sig, secret)).toBe(true)
    })

    it('returns false for wrong-length signature', () => {
      expect(verifyHmacSignature(payload, 'sha256=tooshort', secret)).toBe(false)
    })

    it('returns false for an empty signature', () => {
      expect(verifyHmacSignature(payload, '', secret)).toBe(false)
    })

    it('returns false for incorrect signature of correct length', () => {
      const sig = computeSignature(payload, secret)
      const bad = sig.slice(0, -1) + (sig.at(-1) === 'a' ? 'b' : 'a')
      expect(verifyHmacSignature(payload, bad, secret)).toBe(false)
    })
  })

  describe('redactSecrets', () => {
    it('redacts Bearer tokens', () => {
      const input = 'Authorization header: Bearer eyJhbGciOiJIUzI1NiJ9.token.sig'
      const result = redactSecrets(input)
      expect(result).toContain('Bearer [REDACTED]')
      expect(result).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    })

    it('redacts Authorization headers', () => {
      const input = 'Authorization: BasicdXNlcjpwYXNz'
      const result = redactSecrets(input)
      expect(result).toContain('Authorization: [REDACTED]')
      expect(result).not.toContain('BasicdXNlcjpwYXNz')
    })

    it('redacts API key patterns', () => {
      const input = 'using key sk-live_abc123xyz for access'
      const result = redactSecrets(input)
      expect(result).toContain('[REDACTED]')
      expect(result).not.toContain('abc123xyz')
    })

    it('redacts password patterns', () => {
      const input = 'password=super_secret_value in config'
      const result = redactSecrets(input)
      expect(result).toContain('password=[REDACTED]')
      expect(result).not.toContain('super_secret_value')
    })

    it('redacts URL-embedded passwords', () => {
      const input = 'connecting to https://admin:s3cret@db.example.com/mydb'
      const result = redactSecrets(input)
      expect(result).toContain('[REDACTED]@')
      expect(result).not.toContain('s3cret')
    })

    it('returns the string unchanged when no secrets are present', () => {
      const input = 'just a normal log line with no secrets'
      expect(redactSecrets(input)).toBe(input)
    })
  })
})
