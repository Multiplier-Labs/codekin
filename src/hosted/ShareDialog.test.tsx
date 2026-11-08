/** The share dialog shows whether the owner's signed grant covers the grantee's devices, and signs on Allow. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const grants = vi.hoisted(() => ({ signGrant: vi.fn(), revokeShareGrants: vi.fn(), flushRevocations: vi.fn(), keys: [] as unknown[] }))
vi.mock('./grants', async importOriginal => ({
  ...(await importOriginal<typeof import('./grants')>()),
  fetchGranteeKeys: () => Promise.resolve(grants.keys),
  signGrant: grants.signGrant,
  revokeShareGrants: grants.revokeShareGrants,
  flushRevocations: grants.flushRevocations,
}))
vi.mock('./workspace', () => ({
  currentWorkspaceId: () => 'w1',
  workspaceHeaders: () => ({}),
  fetchMembers: () => Promise.resolve([{ userId: 'u-dana', login: 'dana', displayName: null, role: 'member', status: 'active', accountStatus: 'active' }]),
}))
vi.mock('../lib/transport', () => ({ transport: { signIntent: vi.fn(), sendDeviceFrame: vi.fn() } }))

import { ShareDialog } from './ShareDialog'

const SHARE = {
  id: 'g1', machineId: 'm1', localSessionId: 's1', granteeUserId: 'u-dana',
  permissions: ['view', 'view_diff', 'send_prompt', 'upload_file', 'approve_readonly_tool'], createdAt: 'x', expiresAt: null,
}

let root: Root | null = null
let el: HTMLDivElement | null = null

async function render(share: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/shares') return new Response(JSON.stringify({ shared: [share] }))
    if (url === '/api/me') return new Response(JSON.stringify({ user: { id: 'u-owner' } }))
    return new Response('{}')
  }))
  el = document.createElement('div')
  document.body.appendChild(el)
  root = createRoot(el)
  await act(async () => { root!.render(<ShareDialog machineId="m1" sessionId="s1" sessionName="api-fix" onClose={() => {}} />) })
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  grants.keys = [{ keyId: 'k1', spki: 's', label: 'Pixel Chrome', lastSeenAt: null }]
  grants.revokeShareGrants.mockResolvedValue([])
  grants.flushRevocations.mockResolvedValue([])
})
afterEach(() => {
  act(() => { root?.unmount() })
  el?.remove()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('ShareDialog grants', () => {
  it('shows exactly what will be signed, devices with fingerprints, before signing', async () => {
    grants.signGrant.mockResolvedValue(SHARE)
    grants.keys = [{ keyId: 'k1abcdefgh', spki: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE', label: 'Pixel Chrome', lastSeenAt: null }]
    await render({ ...SHARE, signedGrant: null })
    expect(el!.textContent).toContain('dana · Editor')
    expect(el!.textContent).toContain('1 device: Pixel Chrome (k1abcdef)')
    await act(async () => { [...el!.querySelectorAll('button')].find(b => b.textContent === 'Allow')!.click() })
    await act(async () => { await Promise.resolve() })
    const review = el!.querySelector('[aria-label="Review grant"]')!
    expect(review.textContent).toContain('view, view_diff, send_prompt, upload_file, approve_readonly_tool')
    expect(review.textContent).toContain('For 30 days at a time')
    expect(review.textContent).toContain('k1abcdef')
    expect(grants.signGrant).not.toHaveBeenCalled()
    await act(async () => { [...el!.querySelectorAll('button')].find(b => b.textContent === 'Sign')!.click() })
    expect(grants.signGrant).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ role: 'editor' }))
  })

  it('will not offer to sign a permission list it does not recognise', async () => {
    await render({ ...SHARE, permissions: [...SHARE.permissions, 'approve_shell'], signedGrant: null })
    await act(async () => { [...el!.querySelectorAll('button')].find(b => b.textContent === 'Allow')!.click() })
    await act(async () => { await Promise.resolve() })
    expect(el!.textContent).toContain("doesn't recognise")
    expect(el!.querySelector('[aria-label="Review grant"]')).toBeNull()
  })

  it('says when a revocation is still waiting for the computer', async () => {
    grants.revokeShareGrants.mockResolvedValue(['g1'])
    await render({ ...SHARE, signedGrant: null })
    await act(async () => { [...el!.querySelectorAll('button')].find(b => b.textContent === 'Revoke')!.click() })
    expect(el!.textContent).toContain('Revocation not yet confirmed by the computer (1)')
  })

  it('flags a device the grant does not name', async () => {
    await render({ ...SHARE, signedGrant: { expiresAt: Date.now() + 1e9, permissions: ['view'], keyIds: ['old'] } })
    expect(el!.textContent).toContain('New device: 1 device: Pixel Chrome (k1)')
  })

  it('shows a covered share without an Allow button, and revokes on the machine too', async () => {
    await render({ ...SHARE, signedGrant: { expiresAt: Date.now() + 1e9, permissions: ['view'], keyIds: ['k1'] } })
    expect(el!.textContent).toContain('Allowed on 1 device')
    expect([...el!.querySelectorAll('button')].some(b => b.textContent === 'Allow')).toBe(false)
    await act(async () => { [...el!.querySelectorAll('button')].find(b => b.textContent === 'Revoke')!.click() })
    expect(grants.revokeShareGrants).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'g1' }))
  })
})
