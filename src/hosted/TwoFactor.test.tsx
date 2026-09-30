/** Tests for the 2FA screens: the sign-in challenge, enrollment, and the step-up dialog. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MfaChallengePage, MfaEnrollPage, StepUpHost } from './TwoFactor'
import { stepUpFetch } from './mfa'

vi.mock('./passkeys', () => ({
  passkeysSupported: () => true,
  registerPasskey: () => Promise.resolve({ id: 'p1' }),
  defaultPasskeyLabel: () => 'This device',
  isPasskeyCancel: () => false,
}))
vi.mock('qrcode', () => ({ toDataURL: () => Promise.resolve('data:image/png;base64,') }))

interface Status { totp: boolean; passkeys: number; recoveryCodesRemaining: number; required: boolean; totpAvailable: boolean }
const status = (over: Partial<Status> = {}): Status => ({
  totp: true, passkeys: 0, recoveryCodesRemaining: 10, required: true, totpAvailable: true, ...over,
})

let calls: Array<{ url: string; body: unknown }> = []
function stubRelay(routes: Record<string, (body: unknown) => [number, unknown]>) {
  calls = []
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) as unknown : undefined
    calls.push({ url, body })
    const route = routes[url] as ((b: unknown) => [number, unknown]) | undefined
    const [code, payload] = route ? route(body) : [404, { error: 'not found' }]
    return Promise.resolve(new Response(JSON.stringify(payload), { status: code, headers: { 'content-type': 'application/json' } }))
  }))
}

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null
const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }

async function render(node: React.ReactNode): Promise<HTMLElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => { root = createRoot(container!); root.render(node) })
  await settle()
  return container
}

async function typeAndSubmit(el: HTMLElement, label: string, value: string) {
  const field = el.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setValue.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) })
  await act(async () => { field.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  await settle()
}

const buttonTexts = (el: HTMLElement) => [...el.querySelectorAll('button')].map(b => b.textContent)

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  vi.unstubAllGlobals()
})

describe('MfaChallengePage', () => {
  it('offers a passkey when there is one, and verifies a typed code', async () => {
    stubRelay({
      '/api/auth/mfa': () => [200, { mfa: status({ passkeys: 1 }) }],
      '/api/auth/mfa/verify': () => [200, { authLevel: 'full' }],
    })
    const onVerified = vi.fn()
    const el = await render(<MfaChallengePage login="pat" onVerified={onVerified} onLogout={vi.fn()} />)
    expect(buttonTexts(el)).toContain('Use a passkey')
    await typeAndSubmit(el, 'Authentication code', '123456')
    expect(calls.find(c => c.url === '/api/auth/mfa/verify')?.body).toEqual({ code: '123456' })
    expect(onVerified).toHaveBeenCalled()
  })

  it('shows the relay’s refusal and warns when recovery codes run low', async () => {
    let attempt = 0
    stubRelay({
      '/api/auth/mfa': () => [200, { mfa: status() }],
      '/api/auth/mfa/verify': () => (attempt++ === 0 ? [401, { error: 'invalid_code' }] : [200, { authLevel: 'full', recoveryCodesRemaining: 2 }]),
    })
    const onVerified = vi.fn()
    const el = await render(<MfaChallengePage login="pat" onVerified={onVerified} onLogout={vi.fn()} />)
    await typeAndSubmit(el, 'Authentication code', '000000')
    expect(el.textContent).toContain('That code did not work')
    await typeAndSubmit(el, 'Authentication code', 'ABCDE-FGHJK')
    expect(el.textContent).toContain('2 left')
    expect(onVerified).not.toHaveBeenCalled()
  })
})

describe('MfaEnrollPage', () => {
  it('enrolls with a passkey and ends on recovery codes that must be acknowledged', async () => {
    stubRelay({
      '/api/auth/mfa': () => [200, { mfa: status({ totp: false }) }],
      '/api/auth/mfa/recovery-codes': () => [200, { recoveryCodes: ['AAAAA-BBBBB', 'CCCCC-DDDDD'] }],
    })
    const onDone = vi.fn()
    const el = await render(<MfaEnrollPage login="pat" onDone={onDone} onLogout={vi.fn()} />)
    expect(buttonTexts(el)).toEqual(expect.arrayContaining(['Add a passkey (this device)', 'Use an authenticator app']))
    const add = [...el.querySelectorAll('button')].find(b => b.textContent === 'Add a passkey (this device)')!
    await act(async () => { add.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await settle()
    expect(el.textContent).toContain('AAAAA-BBBBB')
    const cont = [...el.querySelectorAll('button')].find(b => b.textContent === 'Continue')!
    expect(cont.disabled).toBe(true)
    await act(async () => { el.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click() })
    await act(async () => { cont.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onDone).toHaveBeenCalled()
  })

  it('hides the authenticator option when the relay cannot store secrets', async () => {
    stubRelay({ '/api/auth/mfa': () => [200, { mfa: status({ totp: false, totpAvailable: false }) }] })
    const el = await render(<MfaEnrollPage login="pat" onDone={vi.fn()} onLogout={vi.fn()} />)
    expect(buttonTexts(el)).not.toContain('Use an authenticator app')
  })
})

describe('StepUpHost', () => {
  it('prompts on step_up_required, verifies, and lets the original request through', async () => {
    let stepped = false
    stubRelay({
      '/api/auth/mfa': () => [200, { mfa: status() }],
      '/api/auth/mfa/verify': () => { stepped = true; return [200, { authLevel: 'full' }] },
      '/api/auth/device-link/start': () => (stepped ? [200, { requestId: 'r' }] : [401, { error: 'step_up_required', method: 'mfa' }]),
    })
    const el = await render(<StepUpHost />)
    let result: Response | null = null
    await act(async () => { void stepUpFetch('/api/auth/device-link/start', { method: 'POST' }).then(r => { result = r }) })
    await settle()
    expect(el.querySelector('[role="dialog"]')).not.toBeNull()
    await typeAndSubmit(el, 'Authentication code', '123456')
    expect(el.querySelector('[role="dialog"]')).toBeNull()
    expect(result!.status).toBe(200)
    expect(calls.filter(c => c.url === '/api/auth/device-link/start')).toHaveLength(2)
  })
})
