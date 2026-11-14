import { describe, expect, it, vi } from 'vitest'
import { APP_CALL_LIMITS, AppToolCalls } from './app-tool-calls.js'
import type { CodingProcess } from './coding-process.js'
import type { AppToolCallOutcome, AppToolCallRequest } from './mcp-app.js'

function setup(opts: { server?: string | null; alive?: boolean; startable?: boolean; call?: (r: AppToolCallRequest) => Promise<AppToolCallOutcome> } = {}) {
  let now = 1_000_000
  const call = vi.fn(opts.call ?? (async () => ({ ok: true as const, result: { content: [] } })))
  let alive = opts.alive ?? true
  const proc = { isAlive: () => alive, isReady: () => alive, callAppTool: call } as unknown as CodingProcess
  const start = vi.fn(() => { if (opts.startable) alive = true; return !!opts.startable })
  const calls = new AppToolCalls({
    appServer: async () => (opts.server === undefined ? 'latency' : opts.server),
    process: () => proc,
    start,
    now: () => now,
    startTimeoutMs: 0,
  })
  return { calls, call, start, tick: (ms: number) => { now += ms } }
}

describe('AppToolCalls', () => {
  it('runs the tool on the item\'s own server', async () => {
    const { calls, call } = setup()
    expect(await calls.call('s1', 'i1', 'refresh', { days: 3 }, false)).toEqual({ ok: true, result: { content: [] } })
    expect(call).toHaveBeenCalledWith({ server: 'latency', tool: 'refresh', arguments: { days: 3 }, confirmed: false })
  })

  it('refuses what isn\'t an app call it can make', async () => {
    expect(await setup({ server: null }).calls.call('s1', 'i1', 'refresh', {}, false)).toMatchObject({ error: /not an MCP App/ })
    expect(await setup({ alive: false }).calls.call('s1', 'i1', 'refresh', {}, false)).toMatchObject({ error: /couldn't be started/ })
    const { calls } = setup()
    expect(await calls.call('s1', 'i1', 'refresh', [1], false)).toMatchObject({ error: /must be an object/ })
    expect(await calls.call('s1', 'i1', '', {}, false)).toMatchObject({ error: /Invalid/ })
    expect(await calls.call('s1', 'i1', 'refresh', { big: 'x'.repeat(APP_CALL_LIMITS.maxArgsBytes) }, false)).toMatchObject({ error: /too large/ })
  })

  it('starts a stopped session\'s agent for the call', async () => {
    const { calls, call, start } = setup({ alive: false, startable: true })
    expect(await calls.call('s1', 'i1', 'refresh', {}, false)).toMatchObject({ ok: true })
    expect(start).toHaveBeenCalledWith('s1')
    expect(call).toHaveBeenCalled()
  })

  it('limits calls running at once and per minute', async () => {
    const resolvers: Array<() => void> = []
    const { calls, tick } = setup({ call: () => new Promise(r => resolvers.push(() => { r({ ok: true, result: { content: [] } }) })) })
    const running = Array.from({ length: APP_CALL_LIMITS.inFlight }, () => calls.call('s1', 'i1', 't', {}, false))
    await vi.waitFor(() => { expect(resolvers.length).toBe(APP_CALL_LIMITS.inFlight) })
    expect(await calls.call('s1', 'i1', 't', {}, false)).toMatchObject({ error: /already has/ })
    // Another app isn't affected.
    void calls.call('s1', 'i2', 't', {}, false)
    await vi.waitFor(() => { expect(resolvers.length).toBe(APP_CALL_LIMITS.inFlight + 1) })
    resolvers.forEach(r => { r() })
    await Promise.all(running)
    const settleOne = async () => {
      const before = resolvers.length
      const p = calls.call('s1', 'i1', 't', {}, false)
      await vi.waitFor(() => { expect(resolvers.length).toBe(before + 1) })
      resolvers.at(-1)!()
      return p
    }
    for (let i = APP_CALL_LIMITS.inFlight; i < APP_CALL_LIMITS.perMinute; i++) await settleOne()
    expect(await calls.call('s1', 'i1', 't', {}, false)).toMatchObject({ error: /too often/ })
    tick(61_000)
    expect(await settleOne()).toMatchObject({ ok: true })
  })

  it('doesn\'t count a call that waits for confirmation', async () => {
    const { calls } = setup({ call: async (r) => (r.confirmed ? { ok: true, result: { content: [] } } : { ok: false, error: 'confirm', needsConfirmation: true }) })
    for (let i = 0; i < APP_CALL_LIMITS.perMinute + 5; i++) expect(await calls.call('s1', 'i1', 't', {}, false)).toMatchObject({ needsConfirmation: true })
    expect(await calls.call('s1', 'i1', 't', {}, true)).toMatchObject({ ok: true })
  })

  it('refuses a result too large to pass to the app', async () => {
    const { calls } = setup({ call: async () => ({ ok: true, result: { content: [{ type: 'text', text: 'x'.repeat(5 * 1024 * 1024) }] } }) })
    expect(await calls.call('s1', 'i1', 't', {}, false)).toMatchObject({ ok: false, error: /more than 4 MiB/ })
  })
})
