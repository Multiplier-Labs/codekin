/** The share dialog shows whether the owner's signed grant covers the grantee's devices, and signs on Allow. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const grants = vi.hoisted(() => ({ signShareGrant: vi.fn(), revokeShareGrant: vi.fn(), keys: [] as unknown[] }))
vi.mock('./grants', async importOriginal => ({
  ...(await importOriginal<typeof import('./grants')>()),
  fetchGranteeKeys: () => Promise.resolve(grants.keys),
  signShareGrant: grants.signShareGrant,
  revokeShareGrant: grants.revokeShareGrant,
}))
vi.mock('./workspace', () => ({
  currentWorkspaceId: () => 'w1',
  workspaceHeaders: () => ({}),
  fetchMembers: () => Promise.resolve([{ userId: 'u-dana', login: 'dana', displayName: null, role: 'member', status: 'active', accountStatus: 'active' }]),
}))
vi.mock('../lib/transport', () => ({ transport: { signIntent: vi.fn(), sendDeviceFrame: vi.fn() } }))

import { ShareDialog } from './ShareDialog'

const SHARE = { id: 'g1', machineId: 'm1', localSessionId: 's1', granteeUserId: 'u-dana', permissions: ['view', 'send_prompt'], createdAt: 'x', expiresAt: null }

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
  grants.revokeShareGrant.mockResolvedValue(undefined)
})
afterEach(() => {
  act(() => { root?.unmount() })
  el?.remove()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('ShareDialog grants', () => {
  it('names the devices before the owner allows them, then signs', async () => {
    grants.signShareGrant.mockResolvedValue(SHARE)
    await render({ ...SHARE, signedGrant: null })
    expect(el!.textContent).toContain('dana · Editor')
    expect(el!.textContent).toContain('1 device: Pixel Chrome')
    await act(async () => { [...el!.querySelectorAll('button')].find(b => b.textContent === 'Allow')!.click() })
    expect(grants.signShareGrant).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'g1' }), grants.keys)
  })

  it('flags a device the grant does not name', async () => {
    await render({ ...SHARE, signedGrant: { expiresAt: Date.now() + 1e9, permissions: ['view'], keyIds: ['old'] } })
    expect(el!.textContent).toContain('New device: 1 device: Pixel Chrome')
  })

  it('shows a covered share without an Allow button, and revokes on the machine too', async () => {
    await render({ ...SHARE, signedGrant: { expiresAt: Date.now() + 1e9, permissions: ['view'], keyIds: ['k1'] } })
    expect(el!.textContent).toContain('Allowed on 1 device')
    expect([...el!.querySelectorAll('button')].some(b => b.textContent === 'Allow')).toBe(false)
    await act(async () => { [...el!.querySelectorAll('button')].find(b => b.textContent === 'Revoke')!.click() })
    expect(grants.revokeShareGrant).toHaveBeenCalledWith(expect.anything(), 'g1')
  })
})
