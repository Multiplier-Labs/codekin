/**
 * Tests for RelayWebSocket — the WebSocket-shaped adapter the app's socket
 * hooks drive. Pins readyState transitions and handler firing, since
 * useWsConnection depends on standard WebSocket semantics.
 */
import { describe, it, expect, vi } from 'vitest'
import { RelayWebSocket } from './relay-socket'
import type { ChannelHandlers, RelayConnection } from './relay-client'

/** A RelayConnection stand-in that hands the test the channel handlers. */
function fakeConnection() {
  let handlers: ChannelHandlers | null = null
  const connection = {
    openChannel: vi.fn((_id: string, h: ChannelHandlers) => { handlers = h }),
    sendChannelData: vi.fn(),
    closeChannel: vi.fn(),
  } as unknown as RelayConnection

  return {
    connection,
    get handlers() {
      if (!handlers) throw new Error('channel was never opened')
      return handlers
    },
    openChannel: connection.openChannel as unknown as ReturnType<typeof vi.fn>,
    sendChannelData: connection.sendChannelData as unknown as ReturnType<typeof vi.fn>,
    closeChannel: connection.closeChannel as unknown as ReturnType<typeof vi.fn>,
  }
}

describe('lifecycle', () => {
  it('starts CONNECTING and opens the channel immediately', () => {
    const fake = fakeConnection()
    const ws = new RelayWebSocket(fake.connection, 'ch-1')

    expect(ws.readyState).toBe(RelayWebSocket.CONNECTING)
    expect(fake.openChannel).toHaveBeenCalledWith('ch-1', expect.anything())
  })

  it('fires onopen and reports OPEN once the machine is ready', () => {
    const fake = fakeConnection()
    const ws = new RelayWebSocket(fake.connection, 'ch-1')
    const onopen = vi.fn()
    ws.onopen = onopen

    fake.handlers.onReady()

    expect(ws.readyState).toBe(RelayWebSocket.OPEN)
    expect(onopen).toHaveBeenCalledTimes(1)
  })

  it('delivers frames as message events', () => {
    const fake = fakeConnection()
    const ws = new RelayWebSocket(fake.connection, 'ch-1')
    const received: string[] = []
    ws.onmessage = e => { received.push(e.data) }

    fake.handlers.onReady()
    fake.handlers.onData('{"type":"connected"}')

    expect(received).toEqual(['{"type":"connected"}'])
  })

  it('drops frames that arrive before open', () => {
    const fake = fakeConnection()
    const ws = new RelayWebSocket(fake.connection, 'ch-1')
    const onmessage = vi.fn()
    ws.onmessage = onmessage

    fake.handlers.onData('{"type":"early"}')

    expect(onmessage).not.toHaveBeenCalled()
  })
})

describe('send', () => {
  it('relays frames on the channel when open', () => {
    const fake = fakeConnection()
    const ws = new RelayWebSocket(fake.connection, 'ch-1')
    fake.handlers.onReady()

    ws.send('{"type":"input"}')

    expect(fake.sendChannelData).toHaveBeenCalledWith('ch-1', '{"type":"input"}')
  })

  it('silently drops sends before open and after close, as a WebSocket does', () => {
    const fake = fakeConnection()
    const ws = new RelayWebSocket(fake.connection, 'ch-1')

    ws.send('{"type":"early"}')
    fake.handlers.onReady()
    ws.close()
    ws.send('{"type":"late"}')

    expect(fake.sendChannelData).not.toHaveBeenCalled()
  })
})

describe('close', () => {
  it('closes the channel and fires onclose once', () => {
    const fake = fakeConnection()
    const ws = new RelayWebSocket(fake.connection, 'ch-1')
    const onclose = vi.fn()
    ws.onclose = onclose
    fake.handlers.onReady()

    ws.close(1000, 'done')
    ws.close(1000, 'again')

    expect(fake.closeChannel).toHaveBeenCalledTimes(1)
    expect(onclose).toHaveBeenCalledTimes(1)
    expect(ws.readyState).toBe(RelayWebSocket.CLOSED)
  })

  it('surfaces a remote close with its code so the app can react to 4001', () => {
    const fake = fakeConnection()
    const ws = new RelayWebSocket(fake.connection, 'ch-1')
    let closeEvent: CloseEvent | null = null
    ws.onclose = e => { closeEvent = e }
    fake.handlers.onReady()

    fake.handlers.onClose(4001, 'Unauthorized')

    expect(ws.readyState).toBe(RelayWebSocket.CLOSED)
    expect(closeEvent!.code).toBe(4001)
    expect(closeEvent!.reason).toBe('Unauthorized')
  })

  it('fires onerror for a relay-level channel error', () => {
    const fake = fakeConnection()
    const ws = new RelayWebSocket(fake.connection, 'ch-1')
    const onerror = vi.fn()
    ws.onerror = onerror

    fake.handlers.onError({ code: 'machine_offline', message: 'gone' })

    expect(onerror).toHaveBeenCalledTimes(1)
  })
})
