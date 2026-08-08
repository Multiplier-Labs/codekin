/** Tests for RelayConnection — hello handshake, request queuing, id correlation, close semantics. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RelayConnection, RelayRequestError } from './relay-client'

interface Frame {
  kind: string
  id?: string
  payload: Record<string, unknown>
}

/** Minimal WebSocket stand-in that records sent frames and is driven by the test. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static readonly OPEN = 1

  readyState = 0
  sent: Frame[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: ((e: { code: number }) => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as Frame)
  }

  close(): void {
    this.readyState = 3
  }

  /** Complete the connection so the client sends hello. */
  open(): void {
    this.readyState = 1
    this.onopen?.()
  }

  deliver(frame: { kind: string; id?: string; payload: unknown }): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }

  drop(code = 1006): void {
    this.readyState = 3
    this.onclose?.({ code })
  }
}

const originalWebSocket = globalThis.WebSocket

beforeEach(() => {
  FakeWebSocket.instances = []
  vi.stubGlobal('WebSocket', FakeWebSocket)
})

afterEach(() => {
  vi.stubGlobal('WebSocket', originalWebSocket)
  vi.restoreAllMocks()
})

function connect(machineId = 'm1', opts: Partial<ConstructorParameters<typeof RelayConnection>[0]> = {}) {
  const conn = new RelayConnection({ machineId, url: 'ws://relay.test/relay/browser', ...opts })
  conn.connect()
  const socket = FakeWebSocket.instances.at(-1)!
  return { conn, socket }
}

describe('handshake', () => {
  it('sends hello with the bound machine id on open', () => {
    const { socket } = connect('machine-7')
    socket.open()
    expect(socket.sent).toEqual([
      { version: 1, kind: 'hello', payload: { machineId: 'machine-7' } },
    ])
  })

  it('reports the machine status carried by hello_ack', () => {
    const onMachineStatus = vi.fn()
    const { conn, socket } = connect('m1', { onMachineStatus })
    socket.open()
    socket.deliver({ kind: 'hello_ack', payload: { machineId: 'm1', displayName: 'Dev box', online: true } })

    expect(onMachineStatus).toHaveBeenCalledWith(true, 'Dev box')
    expect(conn.connectionState).toBe('open')
  })
})

describe('request', () => {
  it('queues requests made before the handshake completes, then flushes them', async () => {
    const { conn, socket } = connect()
    const pending = conn.request('GET', '/api/repos')
    socket.open()

    // Only hello so far — the request waits for the ack
    expect(socket.sent.map(f => f.kind)).toEqual(['hello'])

    socket.deliver({ kind: 'hello_ack', payload: { machineId: 'm1', displayName: 'Dev', online: true } })
    expect(socket.sent.map(f => f.kind)).toEqual(['hello', 'request'])

    const sentRequest = socket.sent[1]
    socket.deliver({ kind: 'response', id: sentRequest.id, payload: { status: 200, headers: {} } })
    await expect(pending).resolves.toEqual({ status: 200, headers: {} })
  })

  it('correlates concurrent responses by id, in any order', async () => {
    const { conn, socket } = connect()
    socket.open()
    socket.deliver({ kind: 'hello_ack', payload: { machineId: 'm1', displayName: 'Dev', online: true } })

    const first = conn.request('GET', '/api/repos')
    const second = conn.request('GET', '/api/sessions/list')
    const [reqA, reqB] = socket.sent.filter(f => f.kind === 'request')

    socket.deliver({ kind: 'response', id: reqB.id, payload: { status: 201, headers: {} } })
    socket.deliver({ kind: 'response', id: reqA.id, payload: { status: 200, headers: {} } })

    expect((await first).status).toBe(200)
    expect((await second).status).toBe(201)
  })

  it('rejects with the relay error code', async () => {
    const { conn, socket } = connect()
    socket.open()
    socket.deliver({ kind: 'hello_ack', payload: { machineId: 'm1', displayName: 'Dev', online: true } })

    const pending = conn.request('GET', '/api/repos')
    const req = socket.sent.find(f => f.kind === 'request')!
    socket.deliver({ kind: 'error', id: req.id, payload: { code: 'machine_offline', message: 'not connected' } })

    await expect(pending).rejects.toBeInstanceOf(RelayRequestError)
    await expect(pending).rejects.toMatchObject({ code: 'machine_offline' })
  })

  it('rejects in-flight requests when the socket drops', async () => {
    const { conn, socket } = connect()
    socket.open()
    socket.deliver({ kind: 'hello_ack', payload: { machineId: 'm1', displayName: 'Dev', online: true } })

    const pending = conn.request('GET', '/api/repos')
    socket.drop()

    await expect(pending).rejects.toMatchObject({ code: 'disconnected' })
    conn.close()
  })
})

describe('close semantics', () => {
  it('reconnects after an unexpected drop', () => {
    const { conn, socket } = connect()
    socket.open()
    expect(FakeWebSocket.instances).toHaveLength(1)

    vi.useFakeTimers()
    socket.drop(1006)
    vi.advanceTimersByTime(20_000)
    vi.useRealTimers()

    expect(FakeWebSocket.instances.length).toBeGreaterThan(1)
    conn.close()
  })

  it('does not retry after an access refusal', () => {
    const onStateChange = vi.fn()
    const { socket } = connect('m1', { onStateChange })
    socket.open()

    vi.useFakeTimers()
    socket.drop(4003)
    vi.advanceTimersByTime(60_000)
    vi.useRealTimers()

    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(onStateChange).toHaveBeenCalledWith('closed', 'no access to this machine')
  })

  it('stops reconnecting once closed by the caller', () => {
    const { conn, socket } = connect()
    socket.open()
    conn.close()

    vi.useFakeTimers()
    vi.advanceTimersByTime(60_000)
    vi.useRealTimers()

    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(conn.connectionState).toBe('closed')
  })
})
