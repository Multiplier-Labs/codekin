/** Tests for McpAppView's tool calls: run through Codekin, confirmed here when the agent CLI can't check permissions. */
// @vitest-environment jsdom
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

type Handler = (params: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>
const bridges = vi.hoisted(() => [] as Array<{ oncalltool?: Handler; caps: unknown }>)
vi.mock('@modelcontextprotocol/ext-apps/app-bridge', () => ({
  AppBridge: class {
    oncalltool?: Handler
    caps: unknown
    constructor(_client: unknown, _info: unknown, caps: unknown) { this.caps = caps; bridges.push(this) }
    addEventListener() {}
    connect() { return Promise.resolve() }
    close() { return Promise.resolve() }
    sendHostContextChange() { return Promise.resolve() }
  },
  PostMessageTransport: class {},
}))

import McpAppView from './McpAppView'
import type { AppToolOutcome } from '../../hooks/useCanvas'

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLElement | null = null
afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  bridges.length = 0
})

const record = JSON.stringify({ server: 'counter', tool: 'show_counter', toolInput: {}, result: { content: [] }, html: '<p>app</p>' })

function render(onCallTool?: (tool: string, args: Record<string, unknown>, confirmed: boolean) => Promise<AppToolOutcome>) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root!.render(<McpAppView origin="http://localhost:1" content={record} onSendMessage={vi.fn()} onCallTool={onCallTool} />) })
  return { el: container, bridge: bridges.at(-1)! }
}

describe('McpAppView tool calls', () => {
  it('offers tool calls to the app only when Codekin can run them', () => {
    expect(render().bridge.caps).not.toHaveProperty('serverTools')
    act(() => root!.unmount()); root = null
    expect(render(vi.fn()).bridge.caps).toHaveProperty('serverTools')
  })

  it('passes the result straight back when no confirmation is needed', async () => {
    const call = vi.fn(async () => ({ ok: true as const, result: { content: [{ type: 'text', text: 'ok' }] } }))
    const { bridge } = render(call)
    let result: unknown
    await act(async () => { result = await bridge.oncalltool!({ name: 'bump', arguments: { by: 2 } }) })
    expect(call).toHaveBeenCalledWith('bump', { by: 2 }, false)
    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] })
  })

  it('asks here first when the agent CLI can\'t check permissions, and runs it once confirmed', async () => {
    const call = vi.fn(async (_t: string, _a: Record<string, unknown>, confirmed: boolean): Promise<AppToolOutcome> => (
      confirmed ? { ok: true, result: { content: [] } } : { ok: false, error: 'confirm', needsConfirmation: true }))
    const { el, bridge } = render(call)
    let pending!: Promise<unknown>
    await act(async () => { pending = bridge.oncalltool!({ name: 'bump', arguments: { by: 2 } }); await Promise.resolve() })
    const dialog = el.querySelector('[role="dialog"]')!
    expect(dialog.getAttribute('aria-label')).toBe('Run a tool')
    expect(dialog.textContent).toContain('counter wants to run bump')
    expect(dialog.textContent).toContain('"by": 2')
    await act(async () => { [...dialog.querySelectorAll('button')].find(b => b.textContent === 'Run tool')!.click() })
    expect(await pending).toEqual({ content: [] })
    expect(call).toHaveBeenLastCalledWith('bump', { by: 2 }, true)
  })

  it('tells the app when the user declines, without running the tool', async () => {
    const call = vi.fn(async (): Promise<AppToolOutcome> => ({ ok: false, error: 'confirm', needsConfirmation: true }))
    const { el, bridge } = render(call)
    let pending!: Promise<unknown>
    await act(async () => { pending = bridge.oncalltool!({ name: 'bump' }); await Promise.resolve() })
    await act(async () => { [...el.querySelectorAll('[role="dialog"] button')].find(b => b.textContent === 'Cancel')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(await pending).toMatchObject({ isError: true, content: [{ text: 'The user declined this tool call.' }] })
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('explains a refusal by the session\'s permission rules', async () => {
    const { el, bridge } = render(async () => ({ ok: false, error: 'The tool did not run: not granted' }))
    await act(async () => { await bridge.oncalltool!({ name: 'bump' }) })
    expect(el.textContent).toContain('mcp__counter__bump')
  })
})
