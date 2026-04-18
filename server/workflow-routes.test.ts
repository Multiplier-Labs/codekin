/** Tests for parseGitHubSlug and isValidCron — pure helpers exported from workflow-routes. */
import { describe, it, expect } from 'vitest'
import { parseGitHubSlug, isValidCron } from './workflow-routes.js'

describe('parseGitHubSlug', () => {
  it('parses HTTPS URL with .git suffix', () => {
    expect(parseGitHubSlug('https://github.com/Multiplier-Labs/codekin.git')).toBe('Multiplier-Labs/codekin')
  })

  it('parses HTTPS URL without .git suffix', () => {
    expect(parseGitHubSlug('https://github.com/owner/repo')).toBe('owner/repo')
  })

  it('parses SSH URL', () => {
    expect(parseGitHubSlug('git@github.com:owner/repo.git')).toBe('owner/repo')
  })

  it('parses SSH URL without .git suffix', () => {
    expect(parseGitHubSlug('git@github.com:owner/repo')).toBe('owner/repo')
  })

  it('handles trailing whitespace/newline', () => {
    expect(parseGitHubSlug('git@github.com:owner/repo.git\n')).toBe('owner/repo')
  })

  it('returns null for non-GitHub remotes', () => {
    expect(parseGitHubSlug('https://gitlab.com/owner/repo.git')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseGitHubSlug('')).toBeNull()
  })

  it('handles repos with hyphens, underscores, and dots', () => {
    expect(parseGitHubSlug('git@github.com:my-org/my_repo.name.git')).toBe('my-org/my_repo.name')
  })
})

describe('isValidCron', () => {
  it('accepts a plain 5-field expression', () => {
    expect(isValidCron('0 9 * * 1')).toBe(true)
  })

  it('accepts wildcard in every field', () => {
    expect(isValidCron('* * * * *')).toBe(true)
  })

  it('accepts step and range syntax', () => {
    expect(isValidCron('*/15 9-17 * * 1-5')).toBe(true)
  })

  it('rejects fewer than 5 fields', () => {
    expect(isValidCron('0 9 * *')).toBe(false)
  })

  it('rejects more than 5 fields', () => {
    expect(isValidCron('0 9 * * 1 2')).toBe(false)
  })

  it('rejects out-of-range minute (60)', () => {
    expect(isValidCron('60 9 * * 1')).toBe(false)
  })

  it('rejects out-of-range day-of-month (32)', () => {
    expect(isValidCron('0 9 32 * 1')).toBe(false)
  })

  it('rejects non-numeric tokens', () => {
    expect(isValidCron('not a cron expr')).toBe(false)
  })

  it('rejects empty strings', () => {
    expect(isValidCron('')).toBe(false)
  })

  it('rejects inverted ranges', () => {
    expect(isValidCron('5-2 * * * *')).toBe(false)
  })
})
