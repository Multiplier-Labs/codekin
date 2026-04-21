/** Tests for expandTilde and canonicalizeReposPath — helpers exported from session-routes. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'
import { expandTilde, canonicalizeReposPath } from './session-routes.js'

describe('expandTilde', () => {
  it('expands "~/foo" to <home>/foo', () => {
    expect(expandTilde('~/foo')).toBe(join(homedir(), 'foo'))
  })

  it('expands bare "~" to home', () => {
    expect(expandTilde('~')).toBe(homedir())
  })

  it('leaves non-tilde paths untouched', () => {
    expect(expandTilde('/abs/path')).toBe('/abs/path')
    expect(expandTilde('relative/path')).toBe('relative/path')
  })

  it('does not expand tilde inside a segment', () => {
    expect(expandTilde('/foo/~bar')).toBe('/foo/~bar')
  })
})

describe('canonicalizeReposPath', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codekin-canon-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns the canonical absolute path for a valid directory', () => {
    const result = canonicalizeReposPath(dir)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.path.startsWith('/')).toBe(true)
      expect(result.path).not.toContain('~')
    }
  })

  it('resolves symlinks to the real path', () => {
    const target = mkdtempSync(join(tmpdir(), 'codekin-canon-target-'))
    const link = join(dir, 'link')
    symlinkSync(target, link)
    try {
      const result = canonicalizeReposPath(link)
      expect(result.ok).toBe(true)
      if (result.ok) {
        // realpathSync follows the symlink, so we should get `target`
        // (modulo /tmp itself possibly being a symlink — compare canonicalized roots)
        expect(result.path).not.toBe(link)
      }
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('rejects paths that do not exist', () => {
    const result = canonicalizeReposPath(join(dir, 'does-not-exist'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/does not exist/i)
  })

  it('rejects files that are not directories', () => {
    const file = join(dir, 'file.txt')
    writeFileSync(file, 'hello')
    const result = canonicalizeReposPath(file)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/not a directory/i)
  })

  it('rejects a non-existent tilde path rather than persisting raw ~', () => {
    // ~ must be expanded before existence check — a nonsense tilde path is rejected
    const result = canonicalizeReposPath('~/__definitely_not_a_real_dir__')
    expect(result.ok).toBe(false)
  })

  it('expands "~" and returns a path with no tilde when home exists', () => {
    const result = canonicalizeReposPath('~')
    // home is a real directory, so this should succeed and return an absolute
    // canonical path (no raw ~)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.path).not.toContain('~')
      expect(result.path.startsWith('/')).toBe(true)
    }
  })
})
