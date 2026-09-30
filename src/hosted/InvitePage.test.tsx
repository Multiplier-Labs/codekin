/** Tests for the invitation landing page: token handling, what it shows, and the hand-off to GitHub. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { InvitePage } from './InvitePage'

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null

async function render(): Promise<HTMLElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container!)
    root.render(<InvitePage />)
  })
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  return container
}

function stubRelay(preview: unknown, prepareStatus = 200) {
  const fetchMock = vi.fn((url: string) => {
    if (url === '/api/invitations/lookup') {
      return Promise.resolve({ ok: preview !== null, status: preview === null ? 404 : 200, json: () => Promise.resolve({ invitation: preview }) })
    }
    return Promise.resolve({ ok: prepareStatus === 200, status: prepareStatus, json: () => Promise.resolve({}) })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const pending = {
  workspaceName: 'Acme',
  inviterLogin: 'olga',
  role: 'member',
  expiresAt: Date.now() + 60_000,
  boundTo: 'github',
  githubLogin: 'octocat',
  status: 'pending',
}

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  vi.unstubAllGlobals()
  history.replaceState(null, '', '/')
})

describe('InvitePage', () => {
  it('reads the token from the fragment, strips it, and describes the invitation', async () => {
    history.replaceState(null, '', '/invite#tok123')
    const fetchMock = stubRelay(pending)
    const el = await render()
    expect(window.location.hash).toBe('')
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({ token: 'tok123' })
    expect(el.textContent).toContain('olga invited you to join Acme as member')
    expect(el.textContent).toContain('octocat')
  })

  it('parks the token and hands over to GitHub sign-in on accept', async () => {
    history.replaceState(null, '', '/invite#tok123')
    const fetchMock = stubRelay(pending)
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, pathname: '/invite', hash: '#tok123', assign })
    const el = await render()
    const accept = [...el.querySelectorAll('button')].find(b => b.textContent?.includes('Accept with GitHub'))!
    await act(async () => { accept.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(fetchMock.mock.calls.map(c => c[0])).toContain('/api/invitations/prepare')
    expect(assign).toHaveBeenCalledWith('/api/auth/github/start')
  })

  it('explains a used or unknown link instead of offering to accept', async () => {
    history.replaceState(null, '', '/invite#used')
    stubRelay({ ...pending, status: 'accepted' })
    let el = await render()
    expect(el.textContent).toContain('already been used')
    expect(el.textContent).not.toContain('Accept with GitHub')
    act(() => { root?.unmount() })
    container?.remove()

    history.replaceState(null, '', '/invite#nope')
    stubRelay(null)
    el = await render()
    expect(el.textContent).toContain('not valid')
  })
})
