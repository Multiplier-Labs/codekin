/** The public access-request link is shown on the sign-in page, so only safe schemes pass. */
import { describe, it, expect, vi } from 'vitest'
import { parseAccessRequestUrl } from './relay-config.js'

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
