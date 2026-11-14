/** Tests for the Canvas MCP server, its HTTP client, the per-harness config and the REST routes. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import express from 'express'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildCanvasMcpServer, canvasApiFromEnv, type CanvasApi } from './canvas-mcp-server.js'
import { acpCanvasMcpServer, CANVAS_CLAUDE_TOOLS, claudeCanvasMcpConfig, codexCanvasMcpArgs, isCanvasMcpTool } from './canvas-mcp-config.js'
import { createCanvasRouter } from './canvas-routes.js'
import { CanvasSessions } from './canvas-sessions.js'
import { CanvasStore } from './canvas-store.js'
import type { Session } from './types.js'

describe('Canvas MCP tools', () => {
  let client: Client
  let api: CanvasApi & { request: ReturnType<typeof vi.fn> }

  beforeEach(async () => {
    api = { request: vi.fn() }
    const server = buildCanvasMcpServer(api)
    client = new Client({ name: 'test', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(b), client.connect(a)])
  })
  afterEach(async () => { await client.close() })

  it('offers show, update and list, with instructions for the agent', async () => {
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name).sort()).toEqual(['canvas_list', 'canvas_show', 'canvas_update'])
    expect(client.getInstructions()).toMatch(/Canvas beside this chat/)
  })

  it('shows an item and returns its id for later updates', async () => {
    api.request.mockResolvedValue({ item: { id: 'i1', title: 'Report', kind: 'markdown', revision: 1 } })
    const result = await client.callTool({ name: 'canvas_show', arguments: { title: 'Report', kind: 'markdown', content: '# Hi' } })
    expect(api.request).toHaveBeenCalledWith('POST', '/items', { title: 'Report', kind: 'markdown', content: '# Hi' })
    expect(JSON.stringify(result.content)).toMatch(/id i1, revision 1/)
  })

  it('updates by id and reports errors as tool errors', async () => {
    api.request.mockResolvedValueOnce({ item: { id: 'i1', title: 'Report', kind: 'markdown', revision: 2 } })
    await client.callTool({ name: 'canvas_update', arguments: { itemId: 'i1', content: 'v2' } })
    expect(api.request).toHaveBeenCalledWith('POST', '/items/i1', { content: 'v2' })
    api.request.mockRejectedValueOnce(new Error('No Canvas item i9 in this session.'))
    const failed = await client.callTool({ name: 'canvas_update', arguments: { itemId: 'i9', content: 'x' } })
    expect(failed.isError).toBe(true)
    expect(JSON.stringify(failed.content)).toMatch(/No Canvas item i9/)
  })

  it('lists items', async () => {
    api.request.mockResolvedValue({ items: [{ id: 'i1', title: 'Report', kind: 'markdown', revision: 3 }] })
    const result = await client.callTool({ name: 'canvas_list', arguments: {} })
    expect(JSON.stringify(result.content)).toMatch(/i1 {2}markdown {2}rev 3 {2}Report/)
  })
})

describe('canvasApiFromEnv', () => {
  it('needs the session env, and surfaces the server error message', async () => {
    expect(() => canvasApiFromEnv({})).toThrow(/CODEKIN_PORT, CODEKIN_SESSION_ID and CODEKIN_AUTH_TOKEN/)
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Images need a path to the image file.' }), { status: 400 }))
    const api = canvasApiFromEnv({ CODEKIN_PORT: '9', CODEKIN_SESSION_ID: 's 1', CODEKIN_AUTH_TOKEN: 'tok' }, fetchImpl as unknown as typeof fetch)
    await expect(api.request('POST', '/items', { kind: 'image' })).rejects.toThrow('Images need a path to the image file.')
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:9/api/sessions/s%201/canvas/items', expect.objectContaining({
      method: 'POST', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
    }))
  })
})

describe('per-harness config', () => {
  it('builds Claude, Codex and Grok entries', () => {
    expect(JSON.parse(claudeCanvasMcpConfig('/d/canvas-mcp-server.js'))).toEqual({
      mcpServers: { codekin_canvas: { command: process.execPath, args: ['/d/canvas-mcp-server.js'] } },
    })
    expect(CANVAS_CLAUDE_TOOLS).toContain('mcp__codekin_canvas__canvas_show')
    const codex = codexCanvasMcpArgs('/d/canvas-mcp-server.js')
    expect(codex.filter(a => a !== '-c')).toEqual([
      `mcp_servers.codekin_canvas.command=${JSON.stringify(process.execPath)}`,
      'mcp_servers.codekin_canvas.args=["/d/canvas-mcp-server.js"]',
      'mcp_servers.codekin_canvas.env_vars=["CODEKIN_PORT","CODEKIN_SESSION_ID","CODEKIN_AUTH_TOKEN"]',
      'mcp_servers.codekin_canvas.default_tools_approval_mode="approve"',
    ])
    expect(acpCanvasMcpServer('/d/s.js', { CODEKIN_PORT: '1', CODEKIN_AUTH_TOKEN: 't', OTHER: 'x' }).env).toEqual([
      { name: 'CODEKIN_PORT', value: '1' }, { name: 'CODEKIN_AUTH_TOKEN', value: 't' },
    ])
  })

  it('recognizes the Canvas tools under each harness naming', () => {
    expect(isCanvasMcpTool('mcp__codekin_canvas__canvas_show')).toBe(true)
    expect(isCanvasMcpTool('codekin_canvas__canvas_update')).toBe(true)
    expect(isCanvasMcpTool('codekin_canvas.canvas_list')).toBe(true)
    expect(isCanvasMcpTool('codekin_canvas__delete_everything')).toBe(false)
    expect(isCanvasMcpTool('mcp__other__canvas_show')).toBe(false)
  })
})

describe('Canvas REST routes', () => {
  let tmp: string
  let base: string
  let close: () => void

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'canvas-routes-'))
    const repo = path.join(tmp, 'repo')
    mkdirSync(repo)
    writeFileSync(path.join(repo, 'a.md'), '# A')
    const session = { id: 's1', workingDir: repo } as unknown as Session
    const canvas = new CanvasSessions(new CanvasStore(path.join(tmp, 'store')), {
      getSession: id => (id === 's1' ? session : undefined), broadcast: () => {}, broadcastAndHistory: () => {}, sessionsChanged: () => {},
    })
    const app = express()
    app.use(createCanvasRouter(req => req.headers.authorization?.replace(/^Bearer /, ''), (token, sid) => token === `tok-${sid}`, () => canvas))
    const server = app.listen(0)
    await new Promise(r => server.once('listening', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sessions`
    close = () => { server.close() }
  })
  afterEach(() => { close(); rmSync(tmp, { recursive: true, force: true }) })

  const call = (method: string, url: string, token: string, body?: unknown) =>
    fetch(`${base}${url}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })

  it('only accepts the token of the session it addresses', async () => {
    expect((await call('GET', '/s1/canvas/items', 'tok-s2')).status).toBe(401)
    expect((await call('POST', '/s1/canvas/items', 'nope', { kind: 'markdown', content: 'x' })).status).toBe(401)
  })

  it('shows, revises and lists items; agent mistakes are 400s', async () => {
    const created = await (await call('POST', '/s1/canvas/items', 'tok-s1', { kind: 'markdown', path: 'a.md' })).json() as { item: { id: string } }
    expect(created.item).toMatchObject({ title: 'a.md', kind: 'markdown', revision: 1 })
    const revised = await (await call('POST', `/s1/canvas/items/${created.item.id}`, 'tok-s1', { content: '# B' })).json()
    expect(revised).toMatchObject({ item: { revision: 2 } })
    expect(await (await call('GET', '/s1/canvas/items', 'tok-s1')).json()).toMatchObject({ items: [{ id: created.item.id, revision: 2 }] })
    const bad = await call('POST', '/s1/canvas/items', 'tok-s1', { kind: 'image', content: 'x' })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: 'Images need a path to the image file.' })
  })

  it('accepts bodies past the default 100 kB JSON limit', async () => {
    const big = `# Big\\n\\n${'x'.repeat(600 * 1024)}`
    expect((await call('POST', '/s1/canvas/items', 'tok-s1', { title: 'Big', kind: 'markdown', content: big })).status).toBe(200)
  })
})
