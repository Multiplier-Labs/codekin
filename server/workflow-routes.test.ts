/** Tests for parseGitHubSlug — verifies GitHub slug extraction from various remote URL formats. */
import { describe, it, expect } from 'vitest'
import { parseGitHubSlug } from './workflow-routes.js'

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
