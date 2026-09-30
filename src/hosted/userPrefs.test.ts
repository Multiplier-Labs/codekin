/** Tests for the relay-backed hosted preferences: seeding from /api/me and the one-time localStorage migration. */
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { resetUserPrefsForTests, saveUserPrefs, seedUserPrefs, userPref } from './userPrefs'

const fetchMock = vi.fn(async () => new Response('{}'))

beforeEach(() => {
  localStorage.clear()
  resetUserPrefsForTests()
  fetchMock.mockReset().mockImplementation(async () => new Response('{}'))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => { vi.unstubAllGlobals() })

/** Let the fire-and-forget migration request settle. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('seedUserPrefs', () => {
  it('takes the relay copy', () => {
    seedUserPrefs({ workspaceId: 'w1', machineId: 'm1' })
    expect(userPref('workspaceId')).toBe('w1')
    expect(userPref('machineId')).toBe('m1')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('ignores a response without preferences (not fully signed in)', () => {
    resetUserPrefsForTests({ workspaceId: 'w1' })
    seedUserPrefs(null)
    expect(userPref('workspaceId')).toBe('w1')
  })

  it('uploads legacy localStorage values the relay lacks, then removes them', async () => {
    localStorage.setItem('codekin.hosted.workspaceId', 'w-old')
    localStorage.setItem('codekin.hosted.lastMachineId', 'm-old')
    seedUserPrefs({ workspaceId: null, machineId: null })
    expect(userPref('workspaceId')).toBe('w-old')
    expect(userPref('machineId')).toBe('m-old')
    expect(fetchMock).toHaveBeenCalledWith('/api/me/preferences', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ workspaceId: 'w-old', machineId: 'm-old' }),
    }))
    await settle()
    expect(localStorage.getItem('codekin.hosted.workspaceId')).toBeNull()
    expect(localStorage.getItem('codekin.hosted.lastMachineId')).toBeNull()
  })

  it('prefers the relay copy and just drops the legacy keys', () => {
    localStorage.setItem('codekin.hosted.workspaceId', 'w-old')
    seedUserPrefs({ workspaceId: 'w1', machineId: null })
    expect(userPref('workspaceId')).toBe('w1')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(localStorage.getItem('codekin.hosted.workspaceId')).toBeNull()
  })

  it('keeps the legacy keys when the upload never reaches the relay', async () => {
    fetchMock.mockRejectedValue(new Error('offline'))
    localStorage.setItem('codekin.hosted.lastMachineId', 'm-old')
    seedUserPrefs({ workspaceId: 'w1', machineId: null })
    await settle()
    expect(localStorage.getItem('codekin.hosted.lastMachineId')).toBe('m-old')
  })
})

describe('saveUserPrefs', () => {
  it('skips the request when nothing changed', async () => {
    resetUserPrefsForTests({ machineId: 'm1' })
    await saveUserPrefs({ machineId: 'm1' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never rejects, even when the relay is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('offline'))
    await expect(saveUserPrefs({ machineId: 'm2' })).resolves.toBeUndefined()
    expect(userPref('machineId')).toBe('m2')
  })
})
