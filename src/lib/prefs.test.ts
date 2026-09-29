/** Tests for the server-backed prefs store: load, legacy migration, fallback, and debounced saves. */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const mockGetPrefs = vi.hoisted(() => vi.fn<(token: string) => Promise<Record<string, unknown> | null>>())
const mockPutPrefs = vi.hoisted(() => vi.fn<(token: string, patch: Record<string, unknown>) => Promise<void>>())
vi.mock('./ccApi', () => ({ getPrefs: mockGetPrefs, putPrefs: mockPutPrefs }))

import { flush, getPref, loadPrefs, resetPrefsForTest, setPref } from './prefs'

beforeEach(() => {
  localStorage.clear()
  resetPrefsForTest()
  mockGetPrefs.mockReset()
  mockPutPrefs.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('loadPrefs', () => {
  it('loads the server blob into the cache', async () => {
    mockGetPrefs.mockResolvedValue({ theme: 'light', sidebarWidth: 300 })
    await loadPrefs('tok')
    expect(getPref('theme')).toBe('light')
    expect(getPref('sidebarWidth')).toBe(300)
    expect(mockPutPrefs).not.toHaveBeenCalled()
  })

  it('migrates legacy localStorage values the server lacks, then removes them', async () => {
    localStorage.setItem('codekin-settings', JSON.stringify({ token: 'tok', fontSize: 16, theme: 'paper' }))
    localStorage.setItem('codekin-use-worktree', 'false')
    localStorage.setItem('claude-permission-mode', 'plan')
    localStorage.setItem('codekin-left-sidebar-width', '310')
    localStorage.setItem('codekin-starred-docs', JSON.stringify({ '/r': ['README.md'] }))
    localStorage.setItem('codekin-tentative-s1', JSON.stringify(['hello']))
    localStorage.setItem('codekin.repoDrawerTab:/r', 'archive')
    mockGetPrefs.mockResolvedValue({ permissionMode: 'default' })

    await loadPrefs('tok')

    // Server values win over legacy ones.
    expect(getPref('permissionMode')).toBe('default')
    expect(getPref('theme')).toBe('paper')
    expect(getPref('useWorktree')).toBe(false)
    expect(getPref('sidebarWidth')).toBe(310)
    expect(getPref('starredDocs')).toEqual({ '/r': ['README.md'] })
    expect(getPref('tentativeQueues')).toEqual({ s1: ['hello'] })
    expect(getPref('repoDrawerTabs')).toEqual({ '/r': 'archive' })

    const patch = mockPutPrefs.mock.calls[0][1]
    expect(patch).not.toHaveProperty('permissionMode')
    expect(patch).toMatchObject({ theme: 'paper', useWorktree: false, sidebarWidth: 310 })

    expect(localStorage.getItem('codekin-use-worktree')).toBeNull()
    expect(localStorage.getItem('claude-permission-mode')).toBeNull()
    expect(localStorage.getItem('codekin-tentative-s1')).toBeNull()
    expect(localStorage.getItem('codekin.repoDrawerTab:/r')).toBeNull()
    // The token stays; the theme is gone.
    expect(JSON.parse(localStorage.getItem('codekin-settings')!)).toEqual({ token: 'tok' })
  })

  it('keeps legacy values in localStorage when the migration upload fails', async () => {
    localStorage.setItem('codekin-use-worktree', 'false')
    mockGetPrefs.mockResolvedValue({})
    mockPutPrefs.mockRejectedValue(new Error('offline'))
    await loadPrefs('tok')
    expect(getPref('useWorktree')).toBe(false)
    expect(localStorage.getItem('codekin-use-worktree')).toBe('false')
  })

  it('runs on legacy values without deleting them when the server is unreachable', async () => {
    localStorage.setItem('codekin-provider', 'codex')
    mockGetPrefs.mockRejectedValue(new Error('network'))
    await loadPrefs('tok')
    expect(getPref('provider')).toBe('codex')
    expect(localStorage.getItem('codekin-provider')).toBe('codex')
  })

  it('falls back to localStorage when the server predates the endpoint', async () => {
    localStorage.setItem('codekin-provider', 'codex')
    mockGetPrefs.mockResolvedValue(null)
    await loadPrefs('tok')
    expect(getPref('provider')).toBe('codex')

    setPref('sidebarCollapsed', true)
    flush()
    expect(mockPutPrefs).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem('codekin-prefs')!)).toMatchObject({ provider: 'codex', sidebarCollapsed: true })
  })
})

describe('setPref', () => {
  it('batches changes into one debounced patch and sends null for removals', async () => {
    vi.useFakeTimers()
    mockGetPrefs.mockResolvedValue({ activeSessionId: 'old' })
    await loadPrefs('tok')

    setPref('sidebarWidth', 280)
    setPref('sidebarWidth', 290)
    setPref('activeSessionId', undefined)
    expect(mockPutPrefs).not.toHaveBeenCalled()

    vi.advanceTimersByTime(500)
    expect(mockPutPrefs).toHaveBeenCalledTimes(1)
    expect(mockPutPrefs).toHaveBeenCalledWith('tok', { sidebarWidth: 290, activeSessionId: null })
    expect(getPref('activeSessionId')).toBeUndefined()
  })

  it('skips unchanged values', async () => {
    vi.useFakeTimers()
    mockGetPrefs.mockResolvedValue({ sidebarCollapsed: true })
    await loadPrefs('tok')
    setPref('sidebarCollapsed', true)
    vi.advanceTimersByTime(500)
    expect(mockPutPrefs).not.toHaveBeenCalled()
  })
})
