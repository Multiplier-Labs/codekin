/** The public access-request link is shown on the sign-in page, so only safe schemes pass. */
import { describe, it, expect, vi } from 'vitest'
import { parseAccessRequestUrl, parseCanvasSandboxOrigin } from './relay-config.js'

describe('parseAccessRequestUrl', () => {
  it('accepts https and mailto', () => {
    expect(parseAccessRequestUrl('https://codekin.ai/access')).toBe('https://codekin.ai/access')
    expect(parseAccessRequestUrl(' mailto:hello@codekin.ai ')).toBe('mailto:hello@codekin.ai')
  })

  it('treats empty as unset', () => {
    expect(parseAccessRequestUrl('')).toBeUndefined()
  })

  it.each(['http://codekin.ai/access', 'javascript:alert(1)', '/access', 'codekin.ai/access', 'data:text/html,x'])(
    'rejects %j',
    (raw) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect(parseAccessRequestUrl(raw)).toBeUndefined()
      warn.mockRestore()
    },
  )
})

/** The desktop app lets its location window load this origin, so only bare https origins pass. */
describe('parseCanvasSandboxOrigin', () => {
  it('keeps the origin of an https URL', () => {
    expect(parseCanvasSandboxOrigin(' https://sandbox.example.net ')).toBe('https://sandbox.example.net')
    expect(parseCanvasSandboxOrigin('https://sandbox.example.net/index.html')).toBe('https://sandbox.example.net')
    expect(parseCanvasSandboxOrigin('https://sandbox.example.net:8443')).toBe('https://sandbox.example.net:8443')
  })

  it('allows plain http on loopback only', () => {
    expect(parseCanvasSandboxOrigin('http://127.0.0.1:5174')).toBe('http://127.0.0.1:5174')
    expect(parseCanvasSandboxOrigin('http://localhost:5174')).toBe('http://localhost:5174')
  })

  it('treats empty as unset', () => {
    expect(parseCanvasSandboxOrigin('')).toBeUndefined()
  })

  it.each(['http://sandbox.example.net', 'sandbox.example.net', 'javascript:alert(1)', 'codekin://auth'])(
    'rejects %j',
    (raw) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect(parseCanvasSandboxOrigin(raw)).toBeUndefined()
      warn.mockRestore()
    },
  )
})
