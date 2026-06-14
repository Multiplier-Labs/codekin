/** Tests for the glob matcher used by Goal Run readonly constraints. */
import { describe, it, expect } from 'vitest'
import { globToRegExp, matchesAnyGlob } from './glob-match.js'

describe('globToRegExp', () => {
  it('matches a directory tree with **', () => {
    const re = globToRegExp('.github/workflows/**')
    expect(re.test('.github/workflows/ci.yml')).toBe(true)
    expect(re.test('.github/workflows/nested/deploy.yml')).toBe(true)
    expect(re.test('.github/other/ci.yml')).toBe(false)
  })

  it('* does not cross path separators', () => {
    const re = globToRegExp('src/*.ts')
    expect(re.test('src/index.ts')).toBe(true)
    expect(re.test('src/sub/index.ts')).toBe(false)
  })

  it('? matches a single non-slash character', () => {
    const re = globToRegExp('v?.txt')
    expect(re.test('v1.txt')).toBe(true)
    expect(re.test('v12.txt')).toBe(false)
    expect(re.test('v/.txt')).toBe(false)
  })

  it('matches an extension glob', () => {
    const re = globToRegExp('*.lock')
    expect(re.test('yarn.lock')).toBe(true)
    expect(re.test('package-lock.json')).toBe(false)
  })

  it('escapes regex metacharacters in literals', () => {
    const re = globToRegExp('a.b+c')
    expect(re.test('a.b+c')).toBe(true)
    expect(re.test('axbxc')).toBe(false)
  })
})

describe('matchesAnyGlob', () => {
  it('returns true when any pattern matches', () => {
    const globs = ['.github/workflows/**', 'tests/security/**']
    expect(matchesAnyGlob('tests/security/auth.test.ts', globs)).toBe(true)
    expect(matchesAnyGlob('.github/workflows/ci.yml', globs)).toBe(true)
    expect(matchesAnyGlob('src/index.ts', globs)).toBe(false)
  })

  it('returns false for an empty pattern list', () => {
    expect(matchesAnyGlob('anything', [])).toBe(false)
  })
})
