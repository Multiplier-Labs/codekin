/** Tests for usePrStatus — lookup on open and session switch, forced refresh, and dropping responses for other sessions or older requests. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { usePrStatus } from './usePrStatus'
import type { PrStatus, WsClientMessage } from '../types'

let hook: ReturnType<typeof usePrStatus>
let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null
let sent: WsClientMessage[]

const send = (m: WsClientMessage) => { sent.push(m) }

function Harness(props: { sessionId: string | null; isOpen: boolean }) {
  hook = usePrStatus({ send, ...props })
  return null
}

function render(props: { sessionId: string | null; isOpen: boolean }) {
  if (!container) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  }
  act(() => { root!.render(createElement(Harness, props)) })
}

const status = (n: number): PrStatus => ({ state: 'none', message: `lookup ${n}`, pulls: [], dirty: false, fetchedAt: '' })
const lastId = () => (sent.at(-1) as { requestId: number }).requestId

beforeEach(() => { sent = [] })
afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = null
  container = null
})

describe('usePrStatus', () => {
  it('looks up when open and only forces gh on explicit refresh', () => {
    render({ sessionId: 's1', isOpen: true })
    expect(sent.at(-1)).toMatchObject({ type: 'get_pr_status' })
    expect(sent.at(-1)).not.toHaveProperty('refresh')

    act(() => { hook.refresh(true) })
    expect(sent.at(-1)).toMatchObject({ type: 'get_pr_status', refresh: true })
  })

  it('keeps only the latest answer for the current session', () => {
    render({ sessionId: 's1', isOpen: true })
    const first = lastId()
    act(() => { hook.refresh() })

    act(() => { hook.handleMessage({ type: 'pr_status', status: status(1), requestId: first, sessionId: 's1' }) })
    expect(hook.status).toBeNull()

    act(() => { hook.handleMessage({ type: 'pr_status', status: status(2), requestId: lastId(), sessionId: 's2' }) })
    expect(hook.status).toBeNull()

    act(() => { hook.handleMessage({ type: 'pr_status', status: status(3), requestId: lastId(), sessionId: 's1' }) })
    expect(hook.status?.message).toBe('lookup 3')
  })

  it('clears and looks up again on session switch; stays quiet while closed', () => {
    render({ sessionId: 's1', isOpen: true })
    act(() => { hook.handleMessage({ type: 'pr_status', status: status(1), requestId: lastId(), sessionId: 's1' }) })

    render({ sessionId: 's2', isOpen: true })
    expect(hook.status).toBeNull()
    expect(sent).toHaveLength(2)

    render({ sessionId: 's3', isOpen: false })
    expect(sent).toHaveLength(2)
  })
})
