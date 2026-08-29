/** Tests for the shared frontmatter splitter and the tolerant flat parser (YAML first, legacy line-scan fallback). */
import { describe, it, expect } from 'vitest'
import { splitFrontmatter, parseFlatFrontmatter } from './frontmatter.js'

describe('splitFrontmatter', () => {
  it('splits fenced frontmatter from the body', () => {
    const result = splitFrontmatter('---\nkind: x\n---\nThe body.')
    expect(result?.frontmatter).toBe('kind: x')
    expect(result?.body).toBe('The body.')
  })

  it('handles CRLF line endings', () => {
    const result = splitFrontmatter('---\r\nkind: x\r\n---\r\nBody')
    expect(result?.frontmatter).toBe('kind: x')
    expect(result?.body).toBe('Body')
  })

  it('allows a missing trailing newline after the closing fence', () => {
    expect(splitFrontmatter('---\nkind: x\n---')).not.toBeNull()
  })

  it('requires the opening fence on the first line', () => {
    expect(splitFrontmatter('# Title\n---\nkind: x\n---\nbody')).toBeNull()
    expect(splitFrontmatter('no frontmatter at all')).toBeNull()
  })

  it('does not treat a --- inside the body as a second block', () => {
    const result = splitFrontmatter('---\nkind: x\n---\nabove\n---\nbelow')
    expect(result?.body).toBe('above\n---\nbelow')
  })
})

describe('parseFlatFrontmatter', () => {
  it('parses clean YAML, coercing scalars to strings', () => {
    const fields = parseFlatFrontmatter('name: "Review: Daily"\nmaxTurns: 12\nenabled: true')
    expect(fields).toEqual({ name: 'Review: Daily', maxTurns: '12', enabled: 'true' })
  })

  it('falls back to the legacy line scan on a bare second colon (every shipped template)', () => {
    const fields = parseFlatFrontmatter('kind: code-review.daily\ncommitMessage: chore: code review')
    expect(fields.kind).toBe('code-review.daily')
    expect(fields.commitMessage).toBe('chore: code review')
  })

  it('falls back when YAML parses a value as a nested mapping', () => {
    const fields = parseFlatFrontmatter('kind: x\nmaker:\n  provider: claude')
    // Legacy scan reads flat lines only — the nested block is absent, not mangled.
    expect(fields.kind).toBe('x')
    expect(fields.maker).toBeUndefined()
    expect(fields.provider).toBe('claude')
  })

  it('skips null-valued YAML keys', () => {
    expect(parseFlatFrontmatter('kind: x\nmodel:')).toEqual({ kind: 'x' })
  })
})
