/** The post-sign-in return destination must never become an open redirect. */
import { describe, it, expect } from 'vitest'
import { validateReturnTo } from './return-to.js'

describe('validateReturnTo', () => {
  it('accepts the pairing approval page, with or without its code', () => {
    expect(validateReturnTo('/pair')).toBe('/pair')
    expect(validateReturnTo('/pair?code=ABCD-EF23')).toBe('/pair?code=ABCD-EF23')
    expect(validateReturnTo('/pair?code=abcd-ef23')).toBe('/pair?code=abcd-ef23')
  })

  it.each([
    // Off-origin
    '//evil.example',
    '//evil.example/pair',
    '/\\evil.example',
    '\\\\evil.example',
    '/pair/\\evil.example',
    'https://evil.example/pair',
    'http:/pair',
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'data:text/html,hi',
    ' /pair',
    '/pair ',
    'pair',
    // Encoded variants (Express has already decoded one layer)
    '%2F%2Fevil.example',
    '/%2F%2Fevil.example',
    '/pair?code=%2F%2Fevil',
    '/pair%3Fcode=ABCD',
    '/%70air',
    // Other paths and path tricks
    '/',
    '/link',
    '/link#abc',
    '/pairs',
    '/pair/',
    '/pair/../admin',
    '/pair/..%2Fadmin',
    '/pair#code=ABCD',
    '/pair?code=ABCD#frag',
    // Unexpected or extra query keys / values
    '/pair?',
    '/pair?code=',
    '/pair?next=//evil.example',
    '/pair?code=ABCD&next=//evil.example',
    '/pair?code=ABCD&code=EFGH',
    '/pair?code=AB/CD',
    '/pair?code=AB.CD',
    '/pair?code=<script>',
    '/pair?code=ABCD\r\nSet-Cookie: x=1',
    '/pair\nLocation: //evil.example',
    `/pair?code=${'A'.repeat(33)}`,
  ])('rejects %j', (raw) => {
    expect(validateReturnTo(raw)).toBeNull()
  })

  it('rejects non-string query shapes', () => {
    expect(validateReturnTo(undefined)).toBeNull()
    expect(validateReturnTo(['/pair'])).toBeNull()
    expect(validateReturnTo({ path: '/pair' })).toBeNull()
    expect(validateReturnTo(42)).toBeNull()
    expect(validateReturnTo('')).toBeNull()
  })
})
