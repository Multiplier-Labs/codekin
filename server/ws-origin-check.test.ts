/** Tests for isWsOriginAllowed — origin-header gate for WebSocket handshakes. */
import { describe, it, expect } from 'vitest'
import { isWsOriginAllowed, isLiteralSameOrigin } from './ws-origin-check.js'

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

  describe('same-origin page served by this server', () => {
    // CORS_ORIGIN left at its default: the Vite dev server.
    const DEV_DEFAULT = 'http://localhost:5173'

    it('accepts the page origin for loopback and IP-literal hosts, in both modes', () => {
      for (const prod of [true, false]) {
        expect(isWsOriginAllowed('http://127.0.0.1:32352', DEV_DEFAULT, prod, '127.0.0.1:32352')).toBe(true)
        expect(isWsOriginAllowed('http://localhost:32352', DEV_DEFAULT, prod, 'localhost:32352')).toBe(true)
        expect(isWsOriginAllowed('http://[::1]:32352', DEV_DEFAULT, prod, '[::1]:32352')).toBe(true)
        expect(isWsOriginAllowed('http://192.168.1.20:32352', DEV_DEFAULT, prod, '192.168.1.20:32352')).toBe(true)
      }
    })

    it('rejects a cross-site page even when it targets this host', () => {
      expect(isWsOriginAllowed('https://evil.example.com', DEV_DEFAULT, true, '127.0.0.1:32352')).toBe(false)
      expect(isWsOriginAllowed('http://127.0.0.1:9999', DEV_DEFAULT, true, '127.0.0.1:32352')).toBe(false)
      expect(isWsOriginAllowed('http://localhost:32352', DEV_DEFAULT, true, '127.0.0.1:32352')).toBe(false)
    })

    it('does not treat same-origin by domain name as safe (DNS rebinding)', () => {
      expect(isWsOriginAllowed('http://rebind.evil.example:32352', DEV_DEFAULT, true, 'rebind.evil.example:32352')).toBe(false)
      expect(isWsOriginAllowed('https://app.example.com', DEV_DEFAULT, true, 'app.example.com')).toBe(false)
    })

    it('still accepts the configured CORS_ORIGIN for domain deployments', () => {
      expect(isWsOriginAllowed('https://app.example.com', 'https://app.example.com', true, 'app.example.com')).toBe(true)
    })

    it('needs a Host header and an http(s) origin', () => {
      expect(isLiteralSameOrigin('http://127.0.0.1:32352', undefined)).toBe(false)
      expect(isLiteralSameOrigin('null', '127.0.0.1:32352')).toBe(false)
      expect(isLiteralSameOrigin('file://127.0.0.1:32352', '127.0.0.1:32352')).toBe(false)
      expect(isLiteralSameOrigin('HTTP://LOCALHOST:32352', 'localhost:32352')).toBe(true)
    })
  })
})
