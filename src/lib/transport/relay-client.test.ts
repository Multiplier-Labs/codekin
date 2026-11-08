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

describe('resume', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  function openConnection(opts: Partial<ConstructorParameters<typeof RelayConnection>[0]> = {}) {
    const ctx = connect('m1', opts)
    ctx.socket.open()
    ctx.socket.deliver({ kind: 'hello_ack', payload: { online: true } })
    ctx.socket.sent = []
    return ctx
  }

  it('keeps a socket that answers the liveness ping', () => {
    const { conn, socket } = openConnection()
    conn.resume()
    expect(socket.sent).toEqual([{ version: 1, kind: 'ping', payload: {} }])
    socket.deliver({ kind: 'pong', payload: {} })
    vi.advanceTimersByTime(10_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(conn.connectionState).toBe('open')
  })

  it('replaces a socket that does not answer, closing its channels', () => {
    const { conn, socket } = openConnection()
    const onClose = vi.fn()
    conn.openChannel('ch-1', { onReady: vi.fn(), onData: vi.fn(), onClose, onError: vi.fn() })
    conn.resume()
    vi.advanceTimersByTime(2_499)
    expect(FakeWebSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(onClose).toHaveBeenCalledWith(4002, 'relay connection lost')
    expect(FakeWebSocket.instances).toHaveLength(2)
    // The dead socket's late close event must not disturb the new connection.
    socket.drop()
    expect(conn.connectionState).toBe('connecting')
  })

  it('skips a pending backoff and reconnects at once', () => {
    const { conn, socket } = openConnection()
    socket.drop()
    expect(FakeWebSocket.instances).toHaveLength(1)
    conn.resume()
    expect(FakeWebSocket.instances).toHaveLength(2)
    vi.advanceTimersByTime(30_000)
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('does nothing once closed by the caller', () => {
    const { conn } = openConnection()
    conn.close()
    conn.resume()
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

})

describe('enrolment frames', () => {
  function ready() {
    const { conn, socket } = connect()
    socket.open()
    socket.deliver({ kind: 'hello_ack', payload: { online: true, displayName: 'Dev box' } })
    return { conn, socket }
  }

  it('sends an enrol frame and resolves with the reply that answers it', async () => {
    const { conn, socket } = ready()
    const reply = conn.enrol('enrol_commit', { commit: 'c' })
    const sent = socket.sent.at(-1)!
    expect(sent).toMatchObject({ kind: 'enrol_commit', payload: { commit: 'c' } })
    socket.deliver({ kind: 'enrol_challenge', id: sent.id, payload: { enrolId: 'e1' } })
    expect(await reply).toEqual({ enrolId: 'e1' })
  })

  it('rejects with the machine refusal code', async () => {
    const { conn, socket } = ready()
    const reply = conn.enrol('enrol_reveal', {})
    socket.deliver({ kind: 'error', id: socket.sent.at(-1)!.id, payload: { code: 'enrol_refused', message: 'no' } })
    await expect(reply).rejects.toMatchObject({ code: 'enrol_refused' })
  })

  it('does not accept the wrong kind of reply for a request', async () => {
    const { conn, socket } = ready()
    const reply = conn.enrol('enrol_status', { enrolId: 'e1' })
    socket.deliver({ kind: 'response', id: socket.sent.at(-1)!.id, payload: { status: 200, headers: {} } })
    await expect(reply).rejects.toBeInstanceOf(RelayRequestError)
  })
})

describe('signed request retries', () => {
  function ready() {
    const sign = vi.fn(async (input: Parameters<import('./relay-client').RelaySigner['sign']>[0]) => ({
      body: JSON.stringify({ ...input, nonce: input.nonce ?? 'operation-nonce', ts: input.ts ?? Date.now() }), sig: 'test',
    }))
    const signer = { sign, learnPasskeys: vi.fn(async () => {}), verifyMachineTime: vi.fn(async () => true), setClockOffset: vi.fn() }
    const ctx = connect('m1', { signer })
    ctx.socket.open()
    ctx.socket.deliver({ kind: 'hello_ack', payload: { online: true } })
    return { ...ctx, signer }
  }
  const error = { code: 'not_permitted', message: 'Step up', detail: 'intent_step_up_required', stepUpPasskeys: [{ credentialId: 'p', keyId: 'k' }] }

  it('does not retry an ordinary action on an unsigned step-up refusal', async () => {
    const { conn, socket, signer } = ready()
    const pending = conn.request('POST', '/api/sessions/create', btoa('{"name":"ordinary"}'))
    const rejected = expect(pending).rejects.toMatchObject({ detail: 'intent_step_up_required' })
    await vi.waitFor(() => expect(socket.sent.filter(f => f.kind === 'request')).toHaveLength(1))
    socket.deliver({ kind: 'error', id: socket.sent.at(-1)!.id, payload: error })
    await rejected
    expect(signer.sign).toHaveBeenCalledTimes(1)
    expect(signer.learnPasskeys).not.toHaveBeenCalled()
    conn.close()
  })

  it('preserves nonce and timestamp when a privileged retry switches credentials', async () => {
    const { conn, socket, signer } = ready()
    const pending = conn.request('POST', '/api/sessions/create', btoa('{"permissionMode":"bypassPermissions"}'))
    await vi.waitFor(() => expect(socket.sent.filter(f => f.kind === 'request')).toHaveLength(1))
    const first = JSON.parse((socket.sent.at(-1)!.payload.intent as { body: string }).body)
    vi.spyOn(Date, 'now').mockReturnValue(first.ts + 20 * 60_000)
    socket.deliver({ kind: 'error', id: socket.sent.at(-1)!.id, payload: error })
    await vi.waitFor(() => expect(socket.sent.filter(f => f.kind === 'request')).toHaveLength(2))
    const second = JSON.parse((socket.sent.at(-1)!.payload.intent as { body: string }).body)
    expect(second).toMatchObject({ nonce: first.nonce, ts: first.ts, stepUp: true })
    expect(signer.learnPasskeys).toHaveBeenCalledOnce()
    socket.deliver({ kind: 'response', id: socket.sent.at(-1)!.id, payload: { status: 200, headers: {} } })
    await pending
    conn.close()
  })

  it('uses only the authenticated time for this operation on a stale-clock retry', async () => {
    const { conn, socket } = ready()
    const pending = conn.request('POST', '/api/sessions/create')
    await vi.waitFor(() => expect(socket.sent.filter(f => f.kind === 'request')).toHaveLength(1))
    const first = JSON.parse((socket.sent.at(-1)!.payload.intent as { body: string }).body)
    socket.deliver({ kind: 'error', id: socket.sent.at(-1)!.id, payload: {
      code: 'not_permitted', message: 'Stale', detail: 'intent_stale', intentNonce: first.nonce, machineTime: first.ts + 1000, machineTimeSig: 'signed',
    } })
    await vi.waitFor(() => expect(socket.sent.filter(f => f.kind === 'request')).toHaveLength(2))
    expect(JSON.parse((socket.sent.at(-1)!.payload.intent as { body: string }).body)).toMatchObject({ nonce: first.nonce, ts: first.ts + 1000 })
    socket.deliver({ kind: 'response', id: socket.sent.at(-1)!.id, payload: { status: 200, headers: {} } })
    await pending
    conn.close()
  })
})
