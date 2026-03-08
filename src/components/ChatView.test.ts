import { describe, it, expect } from 'vitest'
import { formatModelName, formatUserText } from '../lib/chatFormatters'

describe('formatModelName', () => {
  it('parses claude-opus-4-6 → Opus 4.6', () => {
    expect(formatModelName('claude-opus-4-6')).toBe('Opus 4.6')
  })

  it('parses claude-sonnet-4-6 → Sonnet 4.6', () => {
    expect(formatModelName('claude-sonnet-4-6')).toBe('Sonnet 4.6')
  })

  it('parses claude-haiku-3-5 → Haiku 3.5', () => {
    expect(formatModelName('claude-haiku-3-5')).toBe('Haiku 3.5')
  })

  it('returns raw string for non-matching input', () => {
    expect(formatModelName('gpt-4o')).toBe('gpt-4o')
  })

  it('returns raw string for empty string', () => {
    expect(formatModelName('')).toBe('')
  })
})

describe('formatUserText', () => {
  it('formats single file attachment', () => {
    expect(formatUserText('[Attached file: /tmp/uploads/photo.png]'))
      .toBe('📎 photo.png')
  })

  it('formats multiple file attachments', () => {
    expect(formatUserText('[Attached files: /tmp/a.ts, /tmp/b.ts]'))
      .toBe('📎 a.ts, b.ts')
  })

  it('leaves text without attachments unchanged', () => {
    const text = 'Hello, how are you?'
    expect(formatUserText(text)).toBe(text)
  })

  it('preserves surrounding text', () => {
    expect(formatUserText('Look at this [Attached file: /tmp/f.txt] please'))
      .toBe('Look at this 📎 f.txt please')
  })
})
