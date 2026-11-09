/** The connect gate never leaves an unconfirmed browser stuck: it offers to confirm it. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const sheet = vi.hoisted(() => ({ props: null as null | { onTrusted?: () => void; onClose: () => void; machineName: string } }))
vi.mock('./TrustSheet', () => ({
  TrustSheet: (props: { onTrusted?: () => void; onClose: () => void; machineName: string }) => {
    sheet.props = props
    return <div aria-label="Trust sheet">confirm {props.machineName}</div>
  },
}))

import { MachineConnect, SLOW_CONNECT_MS } from './MachineConnect'
import type { HostedRelayTransport } from '../lib/transport'
import type { Machine } from './machines'

const MACHINE = { id: 'm1', displayName: 'hatchery' } as Machine
let root: Root | null = null
let el: HTMLDivElement | null = null

async function render(fetchImpl: () => Promise<Response>, onConnected = vi.fn()) {
  const transport = { fetch: vi.fn(fetchImpl) } as unknown as HostedRelayTransport
  el = document.createElement('div')
  document.body.appendChild(el)
  root = createRoot(el)
  await act(async () => { root!.render(<MachineConnect machine={MACHINE} transport={transport} onBack={() => {}} onConnected={onConnected} />) })
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve() })
  return { transport, onConnected }
}

const refusal = (body: Record<string, string>) => () => Promise.resolve(new Response(JSON.stringify(body), { status: 502 }))
const button = (text: string) => [...el!.querySelectorAll('button')].find(b => b.textContent === text)

afterEach(() => {
  act(() => { root?.unmount() })
  el?.remove()
  sheet.props = null
  vi.useRealTimers()
})

describe('MachineConnect', () => {
  it('offers to confirm a browser the machine refused as unconfirmed, then retries', async () => {
    let calls = 0
    const { onConnected } = await render(() => {
      calls += 1
      return calls === 1
        ? refusal({ error: 'This computer only accepts actions signed by a browser confirmed on it', relayCode: 'not_permitted', detail: 'intent_required' })()
        : Promise.resolve(new Response('{"sessions":[]}', { status: 200 }))
    })
    expect(el!.textContent).toContain("This browser isn’t confirmed on hatchery")
    expect(el!.textContent).not.toContain('codekin relay connect')
    await act(async () => { button('Confirm this browser')!.click() })
    expect(el!.querySelector('[aria-label="Trust sheet"]')).not.toBeNull()
    await act(async () => { sheet.props!.onTrusted!() })
    for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve() })
    expect(onConnected).toHaveBeenCalled()
  })

  it('treats a key the machine no longer lists the same way', async () => {
    await render(refusal({ error: 'Unknown device key', relayCode: 'not_permitted', detail: 'intent_unknown_key' }))
    expect(button('Confirm this browser')).toBeDefined()
  })

  it('keeps the old advice for a machine that is really offline', async () => {
    await render(refusal({ error: 'Machine is not connected', relayCode: 'machine_offline' }))
    expect(el!.textContent).toContain('Could not reach this machine.')
    expect(button('Retry')).toBeDefined()
    expect(button('Confirm this browser')).toBeUndefined()
  })

  it('offers a way out of a connect that never answers', async () => {
    vi.useFakeTimers()
    await render(() => new Promise<Response>(() => {}))
    expect(button('Confirm this browser')).toBeUndefined()
    await act(async () => { vi.advanceTimersByTime(SLOW_CONNECT_MS + 10) })
    expect(el!.textContent).toContain('taking longer than usual')
    expect(button('Confirm this browser')).toBeDefined()
    expect(button('← Machines')).toBeDefined()
  })
})
