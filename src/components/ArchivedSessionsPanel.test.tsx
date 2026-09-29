/** Tests for ArchivedSessionsList — verifies the Resumable section (repo scoping, de-duplication, Resume) and that working files are only removed after a safe preflight and confirmation. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

const api = vi.hoisted(() => ({
  listArchivedSessions: vi.fn(),
  listArchivedLiveSessions: vi.fn(),
  resumeSession: vi.fn(),
  getRemovalPreflight: vi.fn(),
  removeSessionWorktree: vi.fn(),
  deleteSession: vi.fn(),
  getArchivedSession: vi.fn(),
  deleteArchivedSession: vi.fn(),
}))
vi.mock('../lib/ccApi', () => api)

import { ArchivedSessionsList } from './ArchivedSessionsPanel.js'

const REPO = '/repos/app'
const live = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: `session ${id}`, created: '2026-09-29T00:00:00Z', active: false, workingDir: `${REPO}-wt-${id}`,
  groupDir: REPO, worktreePath: `${REPO}-wt-${id}`, worktreeBranch: `wt/${id}`, archivedAt: new Date().toISOString(),
  connectedClients: 0, lastActivity: '', source: 'manual', ...extra,
})
const transcript = (id: string) => ({
  id, name: `transcript ${id}`, workingDir: REPO, source: 'manual', created: '', archivedAt: new Date().toISOString(), messageCount: 3,
})
const safePreflight = { worktreePath: `${REPO}-wt-a`, branch: 'wt/a', exists: true, modified: [], untracked: [], uniqueCommits: 2, referencedBy: [], safe: true, blockers: [] }

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null

async function render(onResumed = vi.fn()): Promise<HTMLElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container!)
    root.render(<ArchivedSessionsList token="t" workingDir={REPO} onView={vi.fn()} onResumed={onResumed} />)
  })
  return container
}

function button(c: HTMLElement, text: string): HTMLButtonElement {
  const b = [...c.querySelectorAll('button')].find(el => el.textContent?.trim() === text || el.title === text)
  if (!b) throw new Error(`button "${text}" not found`)
  return b as HTMLButtonElement
}

async function click(el: HTMLElement) {
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  api.listArchivedSessions.mockResolvedValue([transcript('t1'), transcript('a')])
  api.listArchivedLiveSessions.mockResolvedValue([live('a'), live('other', { groupDir: '/repos/other' })])
  api.resumeSession.mockResolvedValue(undefined)
  api.getRemovalPreflight.mockResolvedValue(safePreflight)
  api.removeSessionWorktree.mockResolvedValue({ removed: true })
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = null
  container = null
  vi.restoreAllMocks()
})

describe('ArchivedSessionsList resumable section', () => {
  it("shows this repo's resumable sessions above transcripts, without duplicating them", async () => {
    const c = await render()

    const text = c.textContent ?? ''
    expect(text).toContain('Resumable')
    expect(text).toContain('session a')
    expect(text).toContain('wt/a')
    expect(text).not.toContain('session other')
    expect(text).toContain('Transcripts')
    expect(text).toContain('transcript t1')
    expect(text).not.toContain('transcript a')
    expect(text.indexOf('session a')).toBeLessThan(text.indexOf('transcript t1'))
  })

  it('resumes a session and opens it', async () => {
    const onResumed = vi.fn()
    const c = await render(onResumed)

    await click(button(c, 'Resume this session with its worktree'))

    expect(api.resumeSession).toHaveBeenCalledWith('t', 'a')
    expect(onResumed).toHaveBeenCalledWith('a')
  })

  it('removes working files only after a safe preflight and confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const c = await render()

    await click(button(c, 'Actions for session a'))
    await click(button(c, 'Remove working files…'))

    expect(confirm.mock.calls[0][0]).toContain('wt/a and its 2 commit(s) will be kept')
    expect(api.removeSessionWorktree).toHaveBeenCalledWith('t', 'a')
  })

  it('does not remove anything when the user cancels', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const c = await render()

    await click(button(c, 'Actions for session a'))
    await click(button(c, 'Remove working files…'))

    expect(api.removeSessionWorktree).not.toHaveBeenCalled()
  })

  it('explains and refuses when the preflight finds uncommitted work', async () => {
    api.getRemovalPreflight.mockResolvedValue({ ...safePreflight, safe: false, blockers: ['1 file(s) have uncommitted changes.'] })
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {})
    const confirm = vi.spyOn(window, 'confirm')
    const c = await render()

    await click(button(c, 'Actions for session a'))
    await click(button(c, 'Remove working files…'))

    expect(alert.mock.calls[0][0]).toContain('1 file(s) have uncommitted changes.')
    expect(confirm).not.toHaveBeenCalled()
    expect(api.removeSessionWorktree).not.toHaveBeenCalled()
  })

  it('offers no file removal once the files are gone', async () => {
    api.listArchivedLiveSessions.mockResolvedValue([live('a', { worktreeState: 'removed' })])
    const c = await render()

    await click(button(c, 'Actions for session a'))

    expect(c.textContent).toContain('files removed')
    expect([...c.querySelectorAll('[role="menuitem"]')].map(b => b.textContent?.trim())).toEqual(['Delete session'])
  })
})
