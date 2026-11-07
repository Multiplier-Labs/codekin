/** Tests for the Remote access settings page: pairing states, inline unpair confirmation. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const api = vi.hoisted(() => ({
  getRelayStatus: vi.fn(),
  getRelayPairing: vi.fn(),
  startRelayPairing: vi.fn(),
  cancelRelayPairing: vi.fn(),
  unpairRelay: vi.fn(),
}))
vi.mock('../../lib/ccApi', () => api)

import { RemoteAccessSection } from './RemoteAccessSection'

const UNPAIRED = { paired: false, managed: false, state: 'unpaired', machineId: null, relayUrl: null }
const PAIRED = { paired: true, managed: true, state: 'connected', machineId: 'm-1', relayUrl: 'https://app.codekin.ai' }
const PENDING = { state: 'pending', relayUrl: 'https://app.codekin.ai', verificationUrl: 'https://app.codekin.ai/pair?code=ABCD-1234', userCode: 'ABCD-1234', expiresAt: null }

let root: Root | null = null
let el: HTMLDivElement | null = null

async function render(onError = vi.fn()) {
  el = document.createElement('div')
  document.body.appendChild(el)
  root = createRoot(el)
  await act(async () => { root!.render(<RemoteAccessSection token="t" onError={onError} />) })
  await act(async () => { await Promise.resolve() })
  return { el, onError }
}

const button = (text: string) => [...el!.querySelectorAll('button')].find(b => b.textContent?.includes(text))

afterEach(() => {
  act(() => { root?.unmount() })
  el?.remove()
  root = null
  vi.clearAllMocks()
})

describe('RemoteAccessSection', () => {
  it('offers pairing when the machine is not paired, and shows the code to approve', async () => {
    api.getRelayStatus.mockResolvedValue(UNPAIRED)
    api.getRelayPairing.mockResolvedValue({ state: 'idle' })
    api.startRelayPairing.mockResolvedValue(PENDING)
    await render()
    expect(el!.textContent).toContain('Pair with app.codekin.ai')
    await act(async () => { button('Pair this machine')!.click() })
    expect(api.startRelayPairing).toHaveBeenCalledWith('t', undefined)
    expect(el!.querySelector('[aria-label="Pairing code"]')?.textContent).toBe('ABCD-1234')
    const link = el!.querySelector('a[href="https://app.codekin.ai/pair?code=ABCD-1234"]')
    expect(link?.getAttribute('rel')).toContain('noopener')
  })

  it('passes a self-hosted relay URL when one is entered', async () => {
    api.getRelayStatus.mockResolvedValue(UNPAIRED)
    api.getRelayPairing.mockResolvedValue({ state: 'idle' })
    api.startRelayPairing.mockResolvedValue(PENDING)
    await render()
    await act(async () => { button('Use another relay')!.click() })
    const input = el!.querySelector<HTMLInputElement>('#settings-relay-url')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'https://relay.example.com')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { button('Pair this machine')!.click() })
    expect(api.startRelayPairing).toHaveBeenCalledWith('t', 'https://relay.example.com')
  })

  it('reports a failed start through onError', async () => {
    api.getRelayStatus.mockResolvedValue(UNPAIRED)
    api.getRelayPairing.mockResolvedValue({ state: 'idle' })
    api.startRelayPairing.mockRejectedValue(new Error('Could not reach the relay'))
    const { onError } = await render()
    await act(async () => { button('Pair this machine')!.click() })
    expect(onError).toHaveBeenCalledWith('Could not reach the relay')
  })

  it('explains a denied pairing and offers to try again', async () => {
    api.getRelayStatus.mockResolvedValue(UNPAIRED)
    api.getRelayPairing.mockResolvedValue({ state: 'denied', relayUrl: 'https://app.codekin.ai' })
    await render()
    expect(el!.textContent).toContain('Pairing was denied')
    expect(button('Try again')).toBeTruthy()
  })

  it('shows the connection when paired, and unpairs only after inline confirmation', async () => {
    api.getRelayStatus.mockResolvedValue(PAIRED)
    api.getRelayPairing.mockResolvedValue({ state: 'idle' })
    api.unpairRelay.mockResolvedValue({ removed: true })
    await render()
    expect(el!.textContent).toContain('Online')
    expect(el!.textContent).toContain('Machine m-1')
    await act(async () => { button('Unpair…')!.click() })
    expect(api.unpairRelay).not.toHaveBeenCalled()
    api.getRelayStatus.mockResolvedValue(UNPAIRED)
    await act(async () => { button('Unpair this machine')!.click() })
    expect(api.unpairRelay).toHaveBeenCalledWith('t')
    expect(el!.textContent).toContain('Pair this machine')
  })
})
