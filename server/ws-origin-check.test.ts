/** Tests for isWsOriginAllowed — origin-header gate for WebSocket handshakes. */
import { describe, it, expect } from 'vitest'
import { isWsOriginAllowed } from './ws-origin-check.js'

describe('isWsOriginAllowed', () => {
  const CORS = 'https://app.example.com'

  describe('production', () => {
    it('allows a matching Origin', () => {
      expect(isWsOriginAllowed(CORS, CORS, true)).toBe(true)
    })

    it('rejects a mismatched Origin', () => {
      expect(isWsOriginAllowed('https://evil.example.com', CORS, true)).toBe(false)
    })

    it('rejects a missing Origin (W3 — non-browser clients cannot bypass the check)', () => {
      expect(isWsOriginAllowed(undefined, CORS, true)).toBe(false)
    })

    it('rejects an empty-string Origin', () => {
      expect(isWsOriginAllowed('', CORS, true)).toBe(false)
    })
  })

  describe('development', () => {
    it('allows a matching Origin', () => {
      expect(isWsOriginAllowed(CORS, CORS, false)).toBe(true)
    })

    it('rejects a mismatched non-empty Origin', () => {
      expect(isWsOriginAllowed('https://evil.example.com', CORS, false)).toBe(false)
    })

    it('allows a missing Origin (CLI tools)', () => {
      expect(isWsOriginAllowed(undefined, CORS, false)).toBe(true)
    })

    it('allows an empty-string Origin', () => {
      expect(isWsOriginAllowed('', CORS, false)).toBe(true)
    })
  })
})
