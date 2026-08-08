/**
 * A WebSocket-shaped adapter over a relay stream channel.
 *
 * `useWsConnection` and `useChatSocket` drive this exactly as they drive a
 * real WebSocket — same readyState constants, same `onopen`/`onmessage`/
 * `onclose` handlers, same `send`/`close` — so the chat, approval, and diff
 * paths run unmodified against a machine on the other side of the relay.
 *
 * Only the members those hooks use are implemented; the class is exposed as
 * a `WebSocket` through `HostedRelayTransport.openSocket()`.
 */

import type { RelayConnection } from './relay-client'

const CONNECTING = 0
const OPEN = 1
const CLOSING = 2
const CLOSED = 3

/** Close code the local server uses for an auth failure; the app redirects on it. */
const LOCAL_AUTH_FAILED = 4001

/**
 * Event constructors that exist in browsers but not in every Node version
 * (CloseEvent landed late), so the adapter stays usable under test and in
 * any non-DOM context. Consumers only read `data`, `code`, and `reason`.
 */
function makeEvent(type: string): Event {
  return typeof Event === 'function' ? new Event(type) : ({ type } as Event)
}

function makeMessageEvent(data: string): MessageEvent<string> {
  return typeof MessageEvent === 'function'
    ? new MessageEvent('message', { data })
    : ({ type: 'message', data } as MessageEvent<string>)
}

function makeCloseEvent(code: number, reason: string): CloseEvent {
  const init = { code, reason, wasClean: code === 1000 }
  return typeof CloseEvent === 'function'
    ? new CloseEvent('close', init)
    : ({ type: 'close', ...init } as CloseEvent)
}

export class RelayWebSocket {
  static readonly CONNECTING = CONNECTING
  static readonly OPEN = OPEN
  static readonly CLOSING = CLOSING
  static readonly CLOSED = CLOSED

  readonly CONNECTING = CONNECTING
  readonly OPEN = OPEN
  readonly CLOSING = CLOSING
  readonly CLOSED = CLOSED

  readyState: number = CONNECTING
  readonly url: string

  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  private connection: RelayConnection
  private channelId: string

  constructor(connection: RelayConnection, channelId: string) {
    this.connection = connection
    this.channelId = channelId
    this.url = `relay:${channelId}`

    this.connection.openChannel(channelId, {
      onReady: () => {
        if (this.readyState !== CONNECTING) return
        this.readyState = OPEN
        this.onopen?.(makeEvent('open'))
      },
      onData: data => {
        if (this.readyState !== OPEN) return
        this.onmessage?.(makeMessageEvent(data))
      },
      onClose: (code, reason) => { this.finish(code, reason) },
      onError: () => { this.onerror?.(makeEvent('error')) },
    })
  }

  send(data: string): void {
    if (this.readyState !== OPEN) return
    this.connection.sendChannelData(this.channelId, data)
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === CLOSING || this.readyState === CLOSED) return
    this.readyState = CLOSING
    this.connection.closeChannel(this.channelId, code, reason)
    this.finish(code ?? 1000, reason ?? 'closed')
  }

  private finish(code: number, reason: string): void {
    if (this.readyState === CLOSED) return
    this.readyState = CLOSED
    this.onclose?.(makeCloseEvent(code, reason))
  }
}

export { LOCAL_AUTH_FAILED }
