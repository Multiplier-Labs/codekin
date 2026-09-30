/** Tests for the hosted sign-in page: the model, admission, and the return destination. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { LoginPage } from './LoginPage'
import { githubSignInHref } from './signInHref'

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = null
  container = null
  vi.unstubAllGlobals()
})

async function render(ui: React.ReactElement, config: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(config) }))
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container!)
    root.render(ui)
  })
  await act(async () => { await Promise.resolve() })
}

describe('LoginPage', () => {
  it('explains where agents run and that access is by invitation', async () => {
    await render(<LoginPage authError={null} />, { inviteOnly: true })
    expect(container!.textContent).toContain('run on your own computer')
    expect(container!.querySelector('[data-testid="invite-only"]')?.textContent).toBe('Access is currently by invitation.')
  })

  it('points a rejected account to the configured access route', async () => {
    await render(<LoginPage authError="access_not_allowed" />, { inviteOnly: true, accessUrl: 'https://codekin.ai/access' })
    const links = [...container!.querySelectorAll('a')].filter(a => a.textContent === 'Request access')
    expect(links.length).toBeGreaterThan(0)
    expect(links[0].getAttribute('href')).toBe('https://codekin.ai/access')
    expect(container!.textContent).toContain("doesn't have access to this Codekin instance yet")
  })
})

describe('githubSignInHref', () => {
  it('starts plain sign-in from anywhere but the pairing page', () => {
    expect(githubSignInHref({ pathname: '/', search: '' })).toBe('/api/auth/github/start')
    expect(githubSignInHref({ pathname: '/link', search: '' })).toBe('/api/auth/github/start')
  })

  it('carries the pairing code through sign-in', () => {
    expect(githubSignInHref({ pathname: '/pair', search: '?code=ABCD-EF23' }))
      .toBe(`/api/auth/github/start?returnTo=${encodeURIComponent('/pair?code=ABCD-EF23')}`)
  })

  it('drops a code that is not a pairing code, and any other query', () => {
    expect(githubSignInHref({ pathname: '/pair', search: '?code=//evil.example&next=x' }))
      .toBe(`/api/auth/github/start?returnTo=${encodeURIComponent('/pair')}`)
  })
})
