/** Tests for the device-link claim page: nothing is claimed until the user confirms the account. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { LinkClaimPage } from './LinkClaimPage'
import type { HostedUser } from './useHostedAuth'

// Supported, so a successful claim lands on the passkey offer instead of
// navigating away (which jsdom cannot do).
vi.mock('./passkeys', () => ({
  passkeysSupported: () => true,
  registerPasskey: vi.fn(),
  defaultPasskeyLabel: () => 'Test device',
  isPasskeyCancel: () => false,
}))

const CODE = 'a'.repeat(43)

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null

const victim: HostedUser = { id: 'u-a', login: 'alice', displayName: null, avatarUrl: null, status: 'active' }

async function settle() {
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

async function render(currentUser: HostedUser | null | undefined): Promise<HTMLElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container!)
    root.render(<StrictMode><LinkClaimPage currentUser={currentUser} /></StrictMode>)
  })
  await settle()
  return container
}

async function rerender(currentUser: HostedUser | null | undefined) {
  await act(async () => { root!.render(<StrictMode><LinkClaimPage currentUser={currentUser} /></StrictMode>) })
  await settle()
}

function stubRelay({ lookup = 200, complete = 200 }: { lookup?: number; complete?: number } = {}) {
  const fetchMock = vi.fn((url: string) => {
    if (url === '/api/auth/device-link/lookup') {
      return Promise.resolve({
        ok: lookup === 200,
        status: lookup,
        json: () => Promise.resolve({ creator: { id: 'u-m', login: 'mallory', displayName: null, avatarUrl: null } }),
      })
    }
    return Promise.resolve({
      ok: complete === 200,
      status: complete,
      json: () => Promise.resolve({ user: { ...victim, id: 'u-m', login: 'mallory' } }),
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const calls = (fetchMock: ReturnType<typeof stubRelay>, url: string) =>
  fetchMock.mock.calls.filter(([u]) => u === url).length

function button(label: string): HTMLButtonElement {
  const found = [...container!.querySelectorAll('button')].find(b => b.textContent?.includes(label))
  if (!found) throw new Error(`no button "${label}"`)
  return found
}

async function click(label: string) {
  await act(async () => { button(label).dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await settle()
}

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  root = null
  container = null
  vi.unstubAllGlobals()
  history.replaceState(null, '', '/')
})

describe('LinkClaimPage', () => {
  it('names both accounts and claims nothing until Continue', async () => {
    history.replaceState(null, '', `/link#${CODE}`)
    const fetchMock = stubRelay()
    const el = await render(victim)

    expect(window.location.hash).toBe('')
    expect(calls(fetchMock, '/api/auth/device-link/lookup')).toBe(1)
    expect(calls(fetchMock, '/api/auth/device-link/complete')).toBe(0)
    expect(el.textContent).toContain('signed in as @alice')
    expect(el.textContent).toContain('sign this browser in as @mallory instead')

    await click('Continue as @mallory')
    expect(calls(fetchMock, '/api/auth/device-link/complete')).toBe(1)
    expect(el.textContent).toContain('Signed in as mallory')
  })

  it('asks a signed-out browser before signing it in', async () => {
    history.replaceState(null, '', `/link#${CODE}`)
    const fetchMock = stubRelay()
    const el = await render(null)
    expect(el.textContent).toContain('Sign in on this device as @mallory?')
    expect(calls(fetchMock, '/api/auth/device-link/complete')).toBe(0)
    await click('Continue as @mallory')
    expect(calls(fetchMock, '/api/auth/device-link/complete')).toBe(1)
  })

  it('Cancel leaves the code unused', async () => {
    history.replaceState(null, '', `/link#${CODE}`)
    const fetchMock = stubRelay()
    // Cancel heads back to the app; jsdom cannot navigate, so swallow its complaint.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await render(victim)
    await click('Cancel')
    expect(calls(fetchMock, '/api/auth/device-link/complete')).toBe(0)
  })

  it('reports an expired link at lookup without offering to continue', async () => {
    history.replaceState(null, '', `/link#${CODE}`)
    stubRelay({ lookup: 410 })
    const el = await render(victim)
    expect(el.textContent).toContain('This link expired')
    expect(() => button('Continue')).toThrow()
  })

  it('reports a link that expired between lookup and Continue', async () => {
    history.replaceState(null, '', `/link#${CODE}`)
    stubRelay({ complete: 410 })
    const el = await render(victim)
    await click('Continue as @mallory')
    expect(el.textContent).toContain('This link expired')
  })

  it('tells accounts apart by id, not login, which can be re-registered', async () => {
    history.replaceState(null, '', `/link#${CODE}`)
    stubRelay()
    const el = await render({ ...victim, login: 'mallory' })
    expect(el.textContent).toContain('signed in as @mallory')
    expect(el.textContent).toContain('sign this browser in as @mallory instead')
  })

  it('waits to learn who is signed in before offering to continue', async () => {
    history.replaceState(null, '', `/link#${CODE}`)
    const fetchMock = stubRelay()
    const el = await render(undefined)
    expect(el.textContent).toContain('Checking who is signed in')
    expect(button('Continue as @mallory').disabled).toBe(true)

    await rerender(victim)
    expect(button('Continue as @mallory').disabled).toBe(false)
    expect(el.textContent).toContain('signed in as @alice')
    expect(calls(fetchMock, '/api/auth/device-link/complete')).toBe(0)
  })
})
