/** Tests for the pure parts of the device-link and passkey clients. */
import { describe, it, expect } from 'vitest'
import { codeFromHash } from './deviceLink'
import { defaultPasskeyLabel } from './passkeys'

describe('codeFromHash', () => {
  it('accepts a base64url code with or without the leading #', () => {
    const code = 'A'.repeat(43)
    expect(codeFromHash(`#${code}`)).toBe(code)
    expect(codeFromHash(code)).toBe(code)
  })

  it('rejects junk that is not a link code', () => {
    expect(codeFromHash('')).toBeNull()
    expect(codeFromHash('#')).toBeNull()
    expect(codeFromHash('#short')).toBeNull()
    expect(codeFromHash('#has spaces in it and is long enough')).toBeNull()
    expect(codeFromHash(`#${'x'.repeat(200)}`)).toBeNull()
    expect(codeFromHash('#<script>alert(1)</script>xxxxxxxx')).toBeNull()
  })
})

describe('defaultPasskeyLabel', () => {
  it('labels by device family', () => {
    expect(defaultPasskeyLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('iPhone')
    expect(defaultPasskeyLabel('Mozilla/5.0 (Linux; Android 14; Pixel 8)')).toBe('Android')
    expect(defaultPasskeyLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('Mac')
    expect(defaultPasskeyLabel('something unrecognizable')).toBe('This device')
  })
})
