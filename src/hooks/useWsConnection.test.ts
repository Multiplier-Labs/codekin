/** Tests for useWsConnection — reconnect backoff and the drop-triggered auth probe. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'

/** A WebSocket stand-in the test opens, feeds and closes by hand. */
class FakeSocket {
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: ((e: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  send(data: string) { this.sent.push(data) }
  close() { this.readyState = 3 }
  open() { this.readyState = 1; this.onopen?.() }
  message(msg: object) { this.onmessage?.({ data: JSON.stringify(msg) }) }
  drop(code = 1006) { this.readyState = 3; this.onclose?.({ code }) }
}

const { sockets, checkAuthSession, redirectToLogin } = vi.hoisted(() => ({
  sockets: [] as FakeSocket[],
  checkAuthSession: vi.fn(async () => true),
  redirectToLogin: vi.fn(),
}))
vi.mock('../lib/ccApi', () => ({
  openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
  checkAuthSession,
  redirectToLogin,
}))

import { useWsConnection, AUTH_PROBE_MIN_GAP_MS } from './useWsConnection'

let root: Root | null = null

function mount() {
  const onMessageRef = createRef<(msg: unknown) => void>() as React.RefObject<(msg: unknown) => void>
  function Host() {
    useWsConnection({ token: 'tok', onMessageRef })
    return null
  }
  act(() => {
    root = createRoot(document.createElement('div'))
    root.render(createElement(Host))
  })
}

/** Advance fake time inside act, so state updates flush. */
function wait(ms: number) {
  act(() => { vi.advanceTimersByTime(ms) })
}

const last = () => sockets[sockets.length - 1]

beforeEach(() => {
  vi.useFakeTimers()
  sockets.length = 0
  checkAuthSession.mockClear()
  redirectToLogin.mockClear()
})

afterEach(() => {
  act(() => { root?.unmount() })
  root = null
  vi.useRealTimers()
})

describe('useWsConnection', () => {
  it('backs off when the server accepts the socket and closes it before auth', () => {
    mount()
    expect(sockets).toHaveLength(1)
    // Origin not allowed: the upgrade succeeds, then the server closes.
    act(() => { last().open(); last().drop(4003) })
    wait(250)
    expect(sockets).toHaveLength(2)
    act(() => { last().open(); last().drop(4003) })
    wait(250)
    expect(sockets).toHaveLength(2) // the second retry waits 500ms, not 250ms
    wait(250)
    expect(sockets).toHaveLength(3)
    act(() => { last().open(); last().drop(4003) })
    wait(999)
    expect(sockets).toHaveLength(3)
    wait(1)
    expect(sockets).toHaveLength(4)
  })

  it('retries fast again once the server has accepted the auth', () => {
    mount()
    act(() => { last().drop() })
    wait(250)
    act(() => { last().drop() })
    wait(500)
    expect(sockets).toHaveLength(3)
    act(() => { last().open(); last().message({ type: 'connected', connectionId: 'c1' }) })
    act(() => { last().drop() })
    wait(250)
    expect(sockets).toHaveLength(4)
  })

  it('probes the login session at most once per gap while the socket keeps failing', () => {
    mount()
    act(() => { last().open(); last().drop(4003) })
    expect(checkAuthSession).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 4; i++) {
      wait(2000)
      act(() => { last().open(); last().drop(4003) })
    }
    expect(checkAuthSession).toHaveBeenCalledTimes(1)
    wait(AUTH_PROBE_MIN_GAP_MS)
    act(() => { last().open(); last().drop(4003) })
    expect(checkAuthSession).toHaveBeenCalledTimes(2)
  })

  it('still redirects to login on an auth failure close', () => {
    mount()
    act(() => { last().open(); last().drop(4001) })
    expect(redirectToLogin).toHaveBeenCalledTimes(1)
    wait(60_000)
    expect(sockets).toHaveLength(1)
  })
})
