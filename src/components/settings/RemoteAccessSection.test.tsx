/** Tests for the Remote access settings page: pairing states, inline unpair confirmation. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const api = vi.hoisted(() => ({
  getRelayStatus: vi.fn(),
  getRelayPairing: vi.fn(),
  startRelayPairing: vi.fn(),
  cancelRelayPairing: vi.fn(),
  unpairRelay: vi.fn(),
  getRelayDevices: vi.fn(),
  revokeRelayDevice: vi.fn(),
  approveRelayDevice: vi.fn(),
  rejectRelayEnrolment: vi.fn(),
}))
vi.mock('../../lib/ccApi', () => api)

import { RemoteAccessSection } from './RemoteAccessSection'

const UNPAIRED = { paired: false, managed: false, state: 'unpaired', machineId: null, relayUrl: null }
const PAIRED = { paired: true, managed: true, state: 'connected', machineId: 'm-1', relayUrl: 'https://app.codekin.ai' }
const NO_DEVICES = {
  paired: true, machineId: 'm-1', identity: { keyId: 'idkey0000000000000000a', createdAt: '2026-11-08T10:00:00Z' },
  devices: { machineId: 'm-1', ownerUserId: 'u1', policy: 'off', credentials: [], pending: [], pendingCount: 0, approved: [] },
}
const IPHONE = { keyId: 'q3aaaaaaaaaaaaaaaaaaaa', kind: 'browser', userId: 'u1', label: 'Safari · iPhone', addedAt: '2026-11-08T10:00:00Z', addedBy: 'local' }
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

beforeEach(() => {
  api.getRelayDevices.mockResolvedValue({ paired: false, machineId: null, identity: null, devices: null })
})

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

  it('shows the identity key and an empty device list when paired', async () => {
    api.getRelayStatus.mockResolvedValue(PAIRED)
    api.getRelayPairing.mockResolvedValue({ state: 'idle' })
    api.getRelayDevices.mockResolvedValue(NO_DEVICES)
    const { onError } = await render()
    expect(el!.textContent).toContain('Devices that can control this computer')
    expect(el!.textContent).toContain('idkey0000000000000000a')
    expect(el!.textContent).toContain('No devices yet')
    expect(onError).not.toHaveBeenCalled()
  })

  it('removes a device only after inline confirmation', async () => {
    api.getRelayStatus.mockResolvedValue(PAIRED)
    api.getRelayPairing.mockResolvedValue({ state: 'idle' })
    api.getRelayDevices.mockResolvedValue({ ...NO_DEVICES, devices: { ...NO_DEVICES.devices, credentials: [IPHONE] } })
    api.revokeRelayDevice.mockResolvedValue(undefined)
    await render()
    expect(el!.textContent).toContain('Safari · iPhone')
    expect(el!.textContent).toContain('confirmed on this computer')
    await act(async () => { button('Remove…')!.click() })
    expect(api.revokeRelayDevice).not.toHaveBeenCalled()
    api.getRelayDevices.mockResolvedValue(NO_DEVICES)
    await act(async () => { [...el!.querySelectorAll('button')].find(b => b.textContent === 'Remove')!.click() })
    expect(api.revokeRelayDevice).toHaveBeenCalledWith('t', IPHONE.keyId)
    expect(el!.textContent).toContain('No devices yet')
  })

  it('confirms a browser by the code it shows, and turns one down', async () => {
    api.getRelayStatus.mockResolvedValue(PAIRED)
    api.getRelayPairing.mockResolvedValue({ state: 'idle' })
    const waiting = { enrolId: 'e1', userId: 'u1', label: 'Chrome · Android', createdAt: '2026-11-08T10:00:00Z', expiresAt: '2026-11-08T10:10:00Z' }
    api.getRelayDevices.mockResolvedValue({ ...NO_DEVICES, devices: { ...NO_DEVICES.devices, pending: [waiting], pendingCount: 1 } })
    api.approveRelayDevice.mockRejectedValueOnce(new Error('No browser is waiting with that code.'))
    api.approveRelayDevice.mockResolvedValueOnce({ keyId: 'k1', label: 'Chrome · Android', confirmCode: 'KBY-PER' })
    api.rejectRelayEnrolment.mockResolvedValue(undefined)
    await render()
    expect(el!.textContent).toContain('A browser is waiting')
    expect(el!.textContent).toContain('Waiting: Chrome · Android')

    const input = el!.querySelector<HTMLInputElement>('#relay-device-code')!
    const type = async (value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    await type('aaaa-aaaa')
    expect(input.value).toBe('AAAA-AAAA')
    await act(async () => { button('Confirm')!.click() })
    expect(el!.textContent).toContain('No browser is waiting with that code.')

    await type('k7qm-2xpa')
    await act(async () => { button('Confirm')!.click() })
    expect(api.approveRelayDevice).toHaveBeenLastCalledWith('t', 'K7QM-2XPA')
    expect(el!.textContent).toContain('Chrome · Android can now control this computer.')
    expect(el!.querySelector('[aria-label="Code for the browser"]')?.textContent).toBe('KBY-PER')

    await act(async () => { button('Turn down')!.click() })
    expect(api.rejectRelayEnrolment).toHaveBeenCalledWith('t', 'e1')
  })

  it('says so when the device list file is unreadable', async () => {
    api.getRelayStatus.mockResolvedValue(PAIRED)
    api.getRelayPairing.mockResolvedValue({ state: 'idle' })
    api.getRelayDevices.mockResolvedValue({ ...NO_DEVICES, devices: null, error: 'relay-devices.json is not valid JSON' })
    await render()
    expect(el!.textContent).toContain('Device list unreadable')
    expect(el!.textContent).not.toContain('No devices yet')
  })
})
