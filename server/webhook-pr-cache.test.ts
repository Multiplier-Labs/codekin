/** Tests for PR context cache — verifies load/path helpers and graceful degradation. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { homedir } from 'os'
import { join } from 'path'

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
    mkdirSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
  }
})

import { loadPrCache, getCachePath, ensureCacheDir, archivePrCache, deletePrCache } from './webhook-pr-cache.js'
import { existsSync, readFileSync, mkdirSync, renameSync, unlinkSync } from 'fs'

function validCacheJson() {
  return JSON.stringify({
    prNumber: 42,
    repo: 'owner/repo',
    lastReviewedSha: 'abc1234',
    timestamp: '2026-04-03T12:00:00.000Z',
    priorReviewSummary: 'Reviewed auth changes',
    codebaseContext: 'Auth module at src/auth/',
    reviewFindings: 'Found null check issue in auth.ts',
  })
}

describe('getCachePath', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns correct path for owner/repo PR #42', () => {
    const path = getCachePath('owner/repo', 42)
    expect(path).toBe(join(homedir(), '.codekin', 'pr-cache', 'owner', 'repo', 'pr-42.json'))
  })

  it('does not create directories (pure function)', () => {
    getCachePath('owner/repo', 42)
    expect(mkdirSync).not.toHaveBeenCalled()
  })

  it('handles org/name repos correctly', () => {
    const path = getCachePath('my-org/my-project', 7)
    expect(path).toBe(join(homedir(), '.codekin', 'pr-cache', 'my-org', 'my-project', 'pr-7.json'))
  })
})

describe('ensureCacheDir', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the same path as getCachePath', () => {
    const path = ensureCacheDir('owner/repo', 42)
    expect(path).toBe(getCachePath('owner/repo', 42))
  })

  it('creates parent directories', () => {
    ensureCacheDir('owner/repo', 42)
    expect(mkdirSync).toHaveBeenCalledWith(
      join(homedir(), '.codekin', 'pr-cache', 'owner', 'repo'),
      { recursive: true },
    )
  })
})

describe('loadPrCache', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns undefined when file does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false)
    const result = loadPrCache('owner/repo', 42)
    expect(result).toBeUndefined()
  })

  it('returns parsed data when valid JSON exists', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readFileSync).mockReturnValue(validCacheJson())
    const result = loadPrCache('owner/repo', 42)
    expect(result).toBeDefined()
    expect(result!.prNumber).toBe(42)
    expect(result!.repo).toBe('owner/repo')
    expect(result!.lastReviewedSha).toBe('abc1234')
    expect(result!.priorReviewSummary).toBe('Reviewed auth changes')
    expect(result!.codebaseContext).toBe('Auth module at src/auth/')
    expect(result!.reviewFindings).toBe('Found null check issue in auth.ts')
  })

  it('returns undefined on malformed JSON', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readFileSync).mockReturnValue('not valid json {{{')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = loadPrCache('owner/repo', 42)
    expect(result).toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
  })

  it('returns undefined on missing required fields', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      prNumber: 42,
      repo: 'owner/repo',
      // missing other required fields
    }))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = loadPrCache('owner/repo', 42)
    expect(result).toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
  })

  it('reads from the correct path', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readFileSync).mockReturnValue(validCacheJson())
    loadPrCache('my-org/project', 99)
    expect(readFileSync).toHaveBeenCalledWith(
      join(homedir(), '.codekin', 'pr-cache', 'my-org', 'project', 'pr-99.json'),
      'utf-8',
    )
  })
})

describe('archivePrCache', () => {
  beforeEach(() => {
    vi.mocked(existsSync).mockReturnValue(false)
    vi.mocked(renameSync).mockClear()
    vi.mocked(mkdirSync).mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('moves cache file to archived directory', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    archivePrCache('owner/repo', 42)
    expect(mkdirSync).toHaveBeenCalledWith(
      join(homedir(), '.codekin', 'pr-cache', 'owner', 'repo', 'archived'),
      { recursive: true },
    )
    expect(renameSync).toHaveBeenCalledWith(
      join(homedir(), '.codekin', 'pr-cache', 'owner', 'repo', 'pr-42.json'),
      join(homedir(), '.codekin', 'pr-cache', 'owner', 'repo', 'archived', 'pr-42.json'),
    )
  })

  it('creates archived directory if missing', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    archivePrCache('owner/repo', 42)
    expect(mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('archived'),
      { recursive: true },
    )
  })

  it('is a no-op when cache file does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false)
    archivePrCache('owner/repo', 42)
    expect(renameSync).not.toHaveBeenCalled()
  })
})

describe('deletePrCache', () => {
  beforeEach(() => {
    vi.mocked(existsSync).mockReturnValue(false)
    vi.mocked(unlinkSync).mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('removes the cache file', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    deletePrCache('owner/repo', 42)
    expect(unlinkSync).toHaveBeenCalledWith(
      join(homedir(), '.codekin', 'pr-cache', 'owner', 'repo', 'pr-42.json'),
    )
  })

  it('is a no-op when cache file does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false)
    deletePrCache('owner/repo', 42)
    expect(unlinkSync).not.toHaveBeenCalled()
  })
})
