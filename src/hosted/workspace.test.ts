/** Tests for this tab's workspace choice and the UI mirror of the capability matrix. */
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  WORKSPACE_HEADER,
  WORKSPACE_KEY,
  can,
  canManageMember,
  currentWorkspaceId,
  pickWorkspace,
  resetWorkspaceForTests,
  switchWorkspace,
  workspaceHeaders,
  type Workspace,
} from './workspace'
import { LAST_MACHINE_KEY } from './machines'

const ws = (id: string): Workspace => ({ id, name: id, role: 'member', requireMfa: false })

beforeEach(() => {
  localStorage.clear()
  resetWorkspaceForTests()
})

describe('pickWorkspace', () => {
  it('returns to the remembered workspace while the account still belongs to it', () => {
    localStorage.setItem(WORKSPACE_KEY, 'b')
    expect(pickWorkspace([ws('a'), ws('b')])?.id).toBe('b')
    expect(currentWorkspaceId()).toBe('b')
  })

  it('falls back to the first (default) workspace when the remembered one is gone', () => {
    localStorage.setItem(WORKSPACE_KEY, 'gone')
    expect(pickWorkspace([ws('a'), ws('b')])?.id).toBe('a')
    expect(localStorage.getItem(WORKSPACE_KEY)).toBe('a')
  })

  it('keeps this tab where it is even if another tab changed the stored choice', () => {
    pickWorkspace([ws('a'), ws('b')])
    localStorage.setItem(WORKSPACE_KEY, 'b')
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
  it('remembers the new workspace, forgets the machine, and reloads at the root', () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, assign })
    localStorage.setItem(LAST_MACHINE_KEY, 'm1')
    switchWorkspace('b')
    expect(localStorage.getItem(WORKSPACE_KEY)).toBe('b')
    expect(localStorage.getItem(LAST_MACHINE_KEY)).toBeNull()
    expect(assign).toHaveBeenCalledWith('/')
    vi.unstubAllGlobals()
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
