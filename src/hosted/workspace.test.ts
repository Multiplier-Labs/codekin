/** Tests for this tab's workspace choice and the UI mirror of the capability matrix. */
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  WORKSPACE_HEADER,
  can,
  canManageMember,
  consumeJoinedWorkspace,
  currentWorkspaceId,
  pickWorkspace,
  resetWorkspaceForTests,
  switchWorkspace,
  workspaceHeaders,
  type Workspace,
} from './workspace'
import { resetUserPrefsForTests, userPref } from './userPrefs'

const ws = (id: string): Workspace => ({ id, name: id, role: 'member', requireMfa: false })

const fetchMock = vi.fn(async () => new Response('{}'))

beforeEach(() => {
  resetWorkspaceForTests()
  resetUserPrefsForTests()
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => { vi.unstubAllGlobals() })

describe('pickWorkspace', () => {
  it('returns to the remembered workspace while the account still belongs to it', () => {
    resetUserPrefsForTests({ workspaceId: 'b' })
    expect(pickWorkspace([ws('a'), ws('b')])?.id).toBe('b')
    expect(currentWorkspaceId()).toBe('b')
    // Already what the relay has: nothing to save.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('falls back to the first (default) workspace when the remembered one is gone', () => {
    resetUserPrefsForTests({ workspaceId: 'gone' })
    expect(pickWorkspace([ws('a'), ws('b')])?.id).toBe('a')
    expect(userPref('workspaceId')).toBe('a')
    expect(fetchMock).toHaveBeenCalledWith('/api/me/preferences', expect.objectContaining({
      body: JSON.stringify({ workspaceId: 'a' }),
    }))
  })

  it('keeps this tab where it is even if another tab changed the stored choice', () => {
    pickWorkspace([ws('a'), ws('b')])
    resetUserPrefsForTests({ workspaceId: 'b' })
    expect(pickWorkspace([ws('a'), ws('b')])?.id).toBe('a')
  })

  it('is null for an account with no workspace, and sends no header then', () => {
    expect(pickWorkspace([])).toBeNull()
    expect(workspaceHeaders()).toEqual({})
  })

  it('scopes relay calls with the header once chosen', () => {
    pickWorkspace([ws('a')])
    expect(workspaceHeaders()).toEqual({ [WORKSPACE_HEADER]: 'a' })
  })
})

describe('switchWorkspace', () => {
  it('saves the new workspace and forgets the machine before reloading at the root', async () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, assign })
    resetUserPrefsForTests({ workspaceId: 'a', machineId: 'm1' })
    await switchWorkspace('b')
    expect(fetchMock).toHaveBeenCalledWith('/api/me/preferences', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ workspaceId: 'b', machineId: null }),
    }))
    expect(userPref('machineId')).toBeNull()
    expect(assign).toHaveBeenCalledWith('/')
  })
})

describe('capabilities (UI mirror)', () => {
  it('lets owners and admins manage, and only owners touch privileged roles', () => {
    expect(can('admin', 'machine.oversee')).toBe(true)
    expect(can('member', 'machine.oversee')).toBe(false)
    expect(can('viewer', 'machine.pair')).toBe(false)
    expect(canManageMember('admin', 'member', 'viewer')).toBe(true)
    expect(canManageMember('admin', 'member', 'admin')).toBe(false)
    expect(canManageMember('admin', 'admin')).toBe(false)
    expect(canManageMember('owner', 'admin', 'owner')).toBe(true)
    expect(canManageMember('member', 'viewer')).toBe(false)
  })
})

describe('consumeJoinedWorkspace', () => {
  it('opens the tab in the workspace just joined and cleans the URL', () => {
    pickWorkspace([ws('a'), ws('b')])
    history.replaceState(null, '', '/?joined=b&x=1')
    expect(consumeJoinedWorkspace()).toBe('b')
    expect(window.location.search).toBe('?x=1')
    expect(pickWorkspace([ws('a'), ws('b')])?.id).toBe('b')
    history.replaceState(null, '', '/')
    expect(consumeJoinedWorkspace()).toBeNull()
  })
})
