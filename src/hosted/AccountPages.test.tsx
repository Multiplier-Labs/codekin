/** Tests for the Profile page and the operator's Accounts page. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { AccountsSection, ProfileSection } from './AccountPages'
import { pickWorkspace, resetWorkspaceForTests } from './workspace'

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null
const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
async function render(node: React.ReactNode) {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => { root = createRoot(container!); root.render(node) })
  await settle()
  return container
}

let calls: Array<{ url: string; method: string; body: unknown }> = []
function stubRelay(routes: Record<string, (method: string, body: unknown) => [number, unknown]>) {
  calls = []
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body as string) as unknown : undefined
    calls.push({ url, method, body })
    const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix))?.[1]
    const [status, payload] = route ? route(method, body) : [404, {}]
    return Promise.resolve(new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } }))
  }))
}

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  vi.unstubAllGlobals()
  resetWorkspaceForTests()
})

describe('ProfileSection', () => {
  it('shows who is signed in and the current workspace, and signs out', async () => {
    pickWorkspace([{ id: 'ws1', name: 'Acme', role: 'owner', requireMfa: false }])
    stubRelay({
      '/api/me': () => [200, { user: { id: 'u1', login: 'pat', displayName: 'Pat', avatarUrl: null }, isOperator: true, workspaces: [{ id: 'ws1', name: 'Acme' }] }],
      '/api/auth/logout': () => [200, { success: true }],
    })
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, assign })
    const el = await render(<ProfileSection />)
    expect(el.textContent).toContain('Pat')
    expect(el.textContent).toContain('github.com/pat')
    expect(el.textContent).toContain('Acme')
    expect(el.textContent).toContain('Platform operator')
    await act(async () => { [...el.querySelectorAll('button')].find(b => b.textContent === 'Sign out')!.click() })
    await settle()
    expect(calls.some(c => c.url === '/api/auth/logout' && c.method === 'POST')).toBe(true)
    expect(assign).toHaveBeenCalledWith('/')
  })
})

describe('AccountsSection', () => {
  const users = [
    { id: 'op', githubId: 1, login: 'op', displayName: null, avatarUrl: null, status: 'active', canCreateWorkspaces: true, isOperator: true },
    { id: 'u2', githubId: 2, login: 'pat', displayName: 'Pat', avatarUrl: null, status: 'active', canCreateWorkspaces: false, isOperator: false },
  ]

  it('lists accounts, leaves the operator uneditable, and grants workspace creation', async () => {
    stubRelay({
      '/api/users/u2': (_m, body) => [200, { user: { ...users[1], ...(body as object) } }],
      '/api/users': () => [200, { users }],
    })
    const el = await render(<AccountsSection />)
    expect(el.querySelectorAll('select')).toHaveLength(1)
    const box = el.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    await act(async () => { box.click() })
    await settle()
    expect(calls.find(c => c.method === 'PATCH')).toMatchObject({ url: '/api/users/u2', body: { canCreateWorkspaces: true } })
    expect(el.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true)
  })

  it('asks before disabling, and sends nothing if declined', async () => {
    stubRelay({ '/api/users': () => [200, { users }] })
    vi.stubGlobal('confirm', vi.fn(() => false))
    const el = await render(<AccountsSection />)
    const select = el.querySelector('select')!
    await act(async () => {
      select.value = 'disabled'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(calls.some(c => c.method === 'PATCH')).toBe(false)
  })
})
