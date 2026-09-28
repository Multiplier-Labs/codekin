/**
 * Tests for the Workspace section of hosted Settings: what each role is
 * offered, and that relay refusals (last owner) reach the user as text.
 */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkspaceSection } from './WorkspaceSection'
import {
  pickWorkspace,
  resetWorkspaceForTests,
  type PendingInvitation,
  type Workspace,
  type WorkspaceMember,
  type WorkspaceRole,
} from './workspace'

const member = (userId: string, role: WorkspaceRole): WorkspaceMember => ({
  userId,
  login: userId,
  displayName: null,
  avatarUrl: null,
  role,
  status: 'active',
  accountStatus: 'active',
  joinedAt: '2026-09-28 00:00:00',
})

interface Scenario {
  role: WorkspaceRole
  members: WorkspaceMember[]
  invitations?: PendingInvitation[]
  patchStatus?: number
  patchError?: string
}

let calls: Array<{ url: string; method: string; body: unknown }> = []

function mockRelay({ role, members, invitations = [], patchStatus = 200, patchError }: Scenario): void {
  const workspaces: Workspace[] = [
    { id: 'ws1', name: 'Acme', role, requireMfa: false },
    { id: 'ws2', name: 'Side project', role: 'member', requireMfa: false },
  ]
  pickWorkspace(workspaces)
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) as unknown : undefined })
    const json = (status: number, body: unknown) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) })
    if (url === '/api/me') return json(200, { user: { id: 'me' }, workspaces, canCreateWorkspaces: false })
    if (url.endsWith('/members') && method === 'GET') return json(200, { members })
    if (url.endsWith('/invitations') && method === 'GET') return json(200, { invitations })
    if (url.endsWith('/invitations') && method === 'POST') {
      return json(201, { invitation: { id: 'inv1' }, inviteUrl: 'https://app.example.com/invite#tok' })
    }
    if (url.endsWith('/machines') && method === 'GET') {
      return json(200, { machines: [{ id: 'm1', displayName: 'Laptop', hostname: null, platform: null, status: 'offline', lastSeenAt: null, ownerUserId: 'bob', ownerLogin: 'bob', quarantined: true }] })
    }
    if (method === 'PATCH') return json(patchStatus, patchError ? { error: patchError } : { membership: {} })
    return json(200, {})
  }))
}

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null

async function render(): Promise<HTMLElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container!)
    root.render(<WorkspaceSection />)
  })
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  return container
}

const selects = (el: HTMLElement) => [...el.querySelectorAll('select')]
const buttons = (el: HTMLElement) => [...el.querySelectorAll('button')].map(b => b.textContent)

beforeEach(() => {
  calls = []
  localStorage.clear()
  resetWorkspaceForTests()
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  vi.unstubAllGlobals()
})

describe('WorkspaceSection', () => {
  it('shows the workspace, the caller’s role and a switcher to the others', async () => {
    mockRelay({ role: 'member', members: [member('me', 'member'), member('bob', 'owner')] })
    const el = await render()
    expect(el.textContent).toContain('Acme')
    expect(el.textContent).toContain('Member')
    const switcher = selects(el).find(s => s.getAttribute('aria-label') === 'Switch workspace')
    expect([...switcher!.options].map(o => o.textContent)).toContain('Side project')
  })

  it('gives a plain member no management controls and no machine oversight', async () => {
    mockRelay({ role: 'member', members: [member('me', 'member'), member('bob', 'viewer')] })
    const el = await render()
    expect(buttons(el)).not.toContain('Remove')
    expect(buttons(el)).not.toContain('Suspend')
    expect(el.textContent).not.toContain('All machines in this workspace')
    expect(buttons(el)).not.toContain('Delete workspace')
    expect(buttons(el)).toContain('Leave workspace')
  })

  it('lets an admin manage members but not owners, and never offer privileged roles', async () => {
    mockRelay({ role: 'admin', members: [member('me', 'admin'), member('bob', 'member'), member('olga', 'owner')] })
    const el = await render()
    const roleSelects = selects(el).filter(s => /^Role for (?!the invitation)/.test(s.getAttribute('aria-label') ?? ''))
    expect(roleSelects.map(s => s.getAttribute('aria-label'))).toEqual(['Role for bob'])
    expect([...roleSelects[0].options].map(o => o.value)).toEqual(['member', 'viewer'])
    expect(el.textContent).toContain('All machines in this workspace')
    expect(el.textContent).toContain('locked — owner left')
    expect(buttons(el)).not.toContain('Delete workspace')
  })

  it('offers an owner every role and the delete control', async () => {
    mockRelay({ role: 'owner', members: [member('me', 'owner'), member('bob', 'admin')] })
    const el = await render()
    const roleSelect = selects(el).find(s => s.getAttribute('aria-label') === 'Role for bob')!
    expect([...roleSelect.options].map(o => o.value)).toEqual(['owner', 'admin', 'member', 'viewer'])
    expect(buttons(el)).toContain('Delete workspace')
  })

  it('sends a role change and reports a last-owner refusal in words', async () => {
    mockRelay({ role: 'owner', members: [member('me', 'owner'), member('bob', 'owner')], patchStatus: 409, patchError: 'last_owner' })
    const el = await render()
    const roleSelect = selects(el).find(s => s.getAttribute('aria-label') === 'Role for bob')!
    await act(async () => {
      roleSelect.value = 'member'
      roleSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(calls.find(c => c.method === 'PATCH')).toMatchObject({ url: '/api/workspaces/ws1/members/bob', body: { role: 'member' } })
    expect(el.textContent).toContain('A workspace needs at least one owner')
  })

  it('hides invitations from members, and never offers an admin the admin role', async () => {
    mockRelay({ role: 'member', members: [member('me', 'member')] })
    let el = await render()
    expect(el.textContent).not.toContain('Invite people')
    act(() => { root?.unmount() })
    container?.remove()

    mockRelay({ role: 'admin', members: [member('me', 'admin')] })
    el = await render()
    const roleSelect = selects(el).find(s => s.getAttribute('aria-label') === 'Role for the invitation')!
    expect([...roleSelect.options].map(o => o.value)).toEqual(['member', 'viewer'])
  })

  it('creates a GitHub or email invitation and shows the link once', async () => {
    mockRelay({ role: 'owner', members: [member('me', 'owner')] })
    const el = await render()
    const field = el.querySelector<HTMLInputElement>('input[aria-label="GitHub username or email"]')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    for (const value of ['@octocat', 'pat@example.com']) {
      await act(async () => {
        setValue.call(field, value)
        field.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => {
        field.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      })
      for (let i = 0; i < 2; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    }
    const posts = calls.filter(c => c.method === 'POST' && c.url.endsWith('/invitations'))
    expect(posts.map(c => c.body)).toEqual([
      { role: 'member', githubLogin: '@octocat' },
      { role: 'member', email: 'pat@example.com' },
    ])
    expect(el.querySelector<HTMLInputElement>('input[aria-label="Invitation link"]')!.value).toBe('https://app.example.com/invite#tok')
  })

  it('lists pending invitations with new-link and revoke controls', async () => {
    mockRelay({
      role: 'owner',
      members: [member('me', 'owner')],
      invitations: [{ id: 'inv1', role: 'viewer', email: null, githubLogin: 'octocat', createdAt: '2026-09-28', expiresAt: Date.now() + 1000 }],
    })
    const el = await render()
    expect(el.textContent).toContain('octocat')
    expect(buttons(el)).toContain('New link')
    expect(buttons(el)).toContain('Revoke')
  })
})
