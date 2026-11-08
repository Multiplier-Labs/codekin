// @vitest-environment jsdom
/** resolveWebhookEndpointUrl: which URL GitHub should use, directly or through a relay. */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { resolveWebhookEndpointUrl } from './ccApi'
import { setTransport, transport, type CodekinTransport } from './transport'

const original = transport

function viaRelay(): CodekinTransport {
  return { ...original, externalUrl: (p: string) => `https://relay.example.com${p}`, relayMachineId: 'm1' } as CodekinTransport
}

function respond(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
}

afterEach(() => {
  setTransport(original)
  vi.unstubAllGlobals()
})

describe('resolveWebhookEndpointUrl', () => {
  it('uses the machine’s own receiver when talking to it directly', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await resolveWebhookEndpointUrl()).toMatch(/\/api\/webhooks\/github$/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses the relay receiver through a relay, without rotating an existing one', async () => {
    setTransport(viaRelay())
    const fetchMock = vi.fn().mockReturnValue(respond({ enabled: true, url: 'https://relay.example.com/api/hooks/github/t' }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await resolveWebhookEndpointUrl()).toBe('https://relay.example.com/api/hooks/github/t')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'GET' })
  })

  it('turns the relay receiver on when it is off', async () => {
    setTransport(viaRelay())
    const fetchMock = vi.fn()
      .mockReturnValueOnce(respond({ enabled: false, url: null }))
      .mockReturnValueOnce(respond({ enabled: true, url: 'https://relay.example.com/api/hooks/github/new' }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await resolveWebhookEndpointUrl()).toBe('https://relay.example.com/api/hooks/github/new')
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST' })
  })

  it('refuses to rotate a receiver whose URL cannot be shown', async () => {
    setTransport(viaRelay())
    const fetchMock = vi.fn().mockReturnValue(respond({ enabled: true, url: null }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(resolveWebhookEndpointUrl()).rejects.toThrow(/New URL/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
