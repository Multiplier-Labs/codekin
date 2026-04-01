// @vitest-environment jsdom
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Repo, Session, PermissionMode } from '../types'
import { groupKey, useSessionOrchestration, UseSessionOrchestrationParams } from './useSessionOrchestration'

function renderHook<T>(hookFn: () => T): { result: { current: T }; unmount: () => void } {
  const result = { current: undefined as T }
  const container = document.createElement('div')
  let root: ReturnType<typeof createRoot>
  function TestComponent() { result.current = hookFn(); return null }
  act(() => { root = createRoot(container); root.render(createElement(TestComponent)) })
  return { result, unmount: () => act(() => root.unmount()) }
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    name: 'test',
    workingDir: '/repo',
    groupDir: null as unknown as undefined,
    isProcessing: false,
    created: '2026-01-01T00:00:00Z',
    active: true,
    connectedClients: 0,
    lastActivity: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Session
}

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo1',
    workingDir: '/repo',
    name: 'repo',
    path: '/repo',
    skills: [],
    modules: [],
    tags: [],
    ...overrides,
  } as Repo
}

function makeParams(overrides: Partial<UseSessionOrchestrationParams> = {}): UseSessionOrchestrationParams {
  return {
    sessions: [],
    repos: [],
    activeSessionId: null,
    setActiveSessionId: vi.fn(),
    joinSession: vi.fn(),
    leaveSession: vi.fn(),
    clearMessages: vi.fn(),
    wsCreateSession: vi.fn(),
    removeSession: vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined),
    pendingContextRef: { current: null },
    useWorktreeRef: { current: false },
    permissionModeRef: { current: 'default' as PermissionMode },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// groupKey
// ---------------------------------------------------------------------------

describe('groupKey', () => {
  it('returns groupDir when set', () => {
    const s = makeSession({ groupDir: '/group' })
    expect(groupKey(s)).toBe('/group')
  })

  it('falls back to workingDir when groupDir is null/undefined', () => {
    const s = makeSession({ workingDir: '/repo', groupDir: undefined })
    expect(groupKey(s)).toBe('/repo')
  })
})

// ---------------------------------------------------------------------------
// useSessionOrchestration
// ---------------------------------------------------------------------------

describe('useSessionOrchestration', () => {
  let params: UseSessionOrchestrationParams

  beforeEach(() => {
    params = makeParams()
  })

  // -- derived state -------------------------------------------------------

  it('activeSession is null when no activeSessionId', () => {
    params.sessions = [makeSession()]
    params.activeSessionId = null
    const { result, unmount } = renderHook(() => useSessionOrchestration(params))
    expect(result.current.activeSession).toBeNull()
    unmount()
  })

  it('activeSession found by activeSessionId', () => {
    const session = makeSession({ id: 'abc' })
    params.sessions = [session]
    params.activeSessionId = 'abc'
    const { result, unmount } = renderHook(() => useSessionOrchestration(params))
    expect(result.current.activeSession).toEqual(session)
    unmount()
  })

  it('activeWorkingDir derived from activeSession via groupKey', () => {
    const session = makeSession({ id: 's1', groupDir: '/grouped' })
    params.sessions = [session]
    params.activeSessionId = 's1'
    const { result, unmount } = renderHook(() => useSessionOrchestration(params))
    expect(result.current.activeWorkingDir).toBe('/grouped')
    unmount()
  })

  // -- handleOpenSession ---------------------------------------------------

  it('handleOpenSession with existing session: clears, leaves, joins latest', () => {
    const s1 = makeSession({ id: 'old', workingDir: '/repo' })
    const s2 = makeSession({ id: 'latest', workingDir: '/repo' })
    const repo = makeRepo({ workingDir: '/repo' })
    params.sessions = [s1, s2]
    const { result, unmount } = renderHook(() => useSessionOrchestration(params))

    act(() => result.current.handleOpenSession(repo))

    expect(params.clearMessages).toHaveBeenCalled()
    expect(params.leaveSession).toHaveBeenCalled()
    expect(params.joinSession).toHaveBeenCalledWith('latest')
    expect(params.wsCreateSession).not.toHaveBeenCalled()
    unmount()
  })

  it('handleOpenSession with no existing session: creates new', () => {
    const repo = makeRepo({ id: 'myrepo', workingDir: '/newrepo' })
    params.sessions = []
    params.useWorktreeRef = { current: true }
    params.permissionModeRef = { current: 'plan' }
    const { result, unmount } = renderHook(() => useSessionOrchestration(params))

    act(() => result.current.handleOpenSession(repo))

    expect(params.clearMessages).toHaveBeenCalled()
    expect(params.leaveSession).toHaveBeenCalled()
    expect(params.wsCreateSession).toHaveBeenCalledWith('hub:myrepo', '/newrepo', true, 'plan')
    unmount()
  })

  // -- handleSelectSession -------------------------------------------------

  it('handleSelectSession: does nothing if same session', () => {
    params.activeSessionId = 'same'
    params.sessions = [makeSession({ id: 'same' })]
    const { result, unmount } = renderHook(() => useSessionOrchestration(params))

    act(() => result.current.handleSelectSession('same'))

    expect(params.clearMessages).not.toHaveBeenCalled()
    expect(params.joinSession).not.toHaveBeenCalled()
    unmount()
  })

  it('handleSelectSession: clears, leaves, joins new', () => {
    params.activeSessionId = 'old'
    params.sessions = [makeSession({ id: 'old' }), makeSession({ id: 'new' })]
    const { result, unmount } = renderHook(() => useSessionOrchestration(params))

    act(() => result.current.handleSelectSession('new'))

    expect(params.clearMessages).toHaveBeenCalled()
    expect(params.leaveSession).toHaveBeenCalled()
    expect(params.joinSession).toHaveBeenCalledWith('new')
    unmount()
  })

  // -- handleDeleteSession -------------------------------------------------

  it('handleDeleteSession: active session deleted, falls back to same repo session', async () => {
    const s1 = makeSession({ id: 'active', workingDir: '/repo' })
    const s2 = makeSession({ id: 'sibling', workingDir: '/repo' })
    const s3 = makeSession({ id: 'other', workingDir: '/other' })
    params.sessions = [s1, s2, s3]
    params.activeSessionId = 'active'
    const { result, unmount } = renderHook(() => useSessionOrchestration(params))

    await act(() => result.current.handleDeleteSession('active'))

    expect(params.clearMessages).toHaveBeenCalled()
    expect(params.leaveSession).toHaveBeenCalled()
    expect(params.joinSession).toHaveBeenCalledWith('sibling')
    expect(params.removeSession).toHaveBeenCalledWith('active')
    unmount()
  })

  it('handleDeleteSession: active session deleted, falls back to any session', async () => {
    const s1 = makeSession({ id: 'active', workingDir: '/repo' })
    const s2 = makeSession({ id: 'other', workingDir: '/other' })
    params.sessions = [s1, s2]
    params.activeSessionId = 'active'
    const { result, unmount } = renderHook(() => useSessionOrchestration(params))

    await act(() => result.current.handleDeleteSession('active'))

    expect(params.joinSession).toHaveBeenCalledWith('other')
    expect(params.removeSession).toHaveBeenCalledWith('active')
    unmount()
  })

  it('handleDeleteSession: last session deleted, sets null', async () => {
    const s1 = makeSession({ id: 'only' })
    params.sessions = [s1]
    params.activeSessionId = 'only'
    const { result, unmount } = renderHook(() => useSessionOrchestration(params))

    await act(() => result.current.handleDeleteSession('only'))

    expect(params.setActiveSessionId).toHaveBeenCalledWith(null)
    expect(params.joinSession).not.toHaveBeenCalled()
    expect(params.removeSession).toHaveBeenCalledWith('only')
    unmount()
  })

  // -- handleSelectRepo ----------------------------------------------------

  it('handleSelectRepo: joins latest session in target repo', () => {
    const s1 = makeSession({ id: 'a', workingDir: '/other' })
    const s2 = makeSession({ id: 'b', workingDir: '/target' })
    const s3 = makeSession({ id: 'c', workingDir: '/target' })
    params.sessions = [s1, s2, s3]
    params.activeSessionId = 'a'
    const { result, unmount } = renderHook(() => useSessionOrchestration(params))

    act(() => result.current.handleSelectRepo('/target'))

    expect(params.clearMessages).toHaveBeenCalled()
    expect(params.leaveSession).toHaveBeenCalled()
    expect(params.joinSession).toHaveBeenCalledWith('c')
    unmount()
  })

  // -- handleDeleteRepo ----------------------------------------------------

  it('handleDeleteRepo: deletes all sessions for repo', async () => {
    const s1 = makeSession({ id: 'a', workingDir: '/repo' })
    const s2 = makeSession({ id: 'b', workingDir: '/repo' })
    const s3 = makeSession({ id: 'c', workingDir: '/other' })
    params.sessions = [s1, s2, s3]
    params.activeSessionId = 'a'
    const { result, unmount } = renderHook(() => useSessionOrchestration(params))

    await act(() => result.current.handleDeleteRepo('/repo'))

    expect(params.clearMessages).toHaveBeenCalled()
    expect(params.leaveSession).toHaveBeenCalled()
    expect(params.joinSession).toHaveBeenCalledWith('c')
    expect(params.removeSession).toHaveBeenCalledWith('a')
    expect(params.removeSession).toHaveBeenCalledWith('b')
    expect(params.removeSession).not.toHaveBeenCalledWith('c')
    unmount()
  })

  // -- handleNewSessionForRepo ---------------------------------------------

  it('handleNewSessionForRepo: creates session for active repo', () => {
    const session = makeSession({ id: 's1', workingDir: '/repo' })
    const repo = makeRepo({ id: 'repo1', workingDir: '/repo' })
    params.sessions = [session]
    params.repos = [repo]
    params.activeSessionId = 's1'
    params.useWorktreeRef = { current: true }
    params.permissionModeRef = { current: 'acceptEdits' }
    const { result, unmount } = renderHook(() => useSessionOrchestration(params))

    act(() => result.current.handleNewSessionForRepo())

    expect(params.clearMessages).toHaveBeenCalled()
    expect(params.leaveSession).toHaveBeenCalled()
    expect(params.wsCreateSession).toHaveBeenCalledWith('hub:repo1', '/repo', true, 'acceptEdits')
    unmount()
  })

  // -- handleNewSessionFromArchive -----------------------------------------

  it('handleNewSessionFromArchive: sets pendingContextRef, creates session', () => {
    const repo = makeRepo({ id: 'repo1', workingDir: '/repo' })
    params.repos = [repo]
    params.useWorktreeRef = { current: false }
    params.permissionModeRef = { current: 'default' }
    const { result, unmount } = renderHook(() => useSessionOrchestration(params))

    act(() => result.current.handleNewSessionFromArchive('/repo', 'archived context'))

    expect(params.pendingContextRef.current).toBe('archived context')
    expect(params.clearMessages).toHaveBeenCalled()
    expect(params.leaveSession).toHaveBeenCalled()
    expect(params.wsCreateSession).toHaveBeenCalledWith('hub:repo1', '/repo', false, 'default')
    unmount()
  })
})
