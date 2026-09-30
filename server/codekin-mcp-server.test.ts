import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildCodekinMcpServer } from './codekin-mcp-server.js'
import { CodekinApi } from './codekin-mcp-api.js'

describe('spawn_child MCP harness selection', () => {
  const api = new CodekinApi({ baseUrl: 'http://unused.test', token: 'test' })
  let client: Client
  let server: ReturnType<typeof buildCodekinMcpServer>
  let spawn: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    spawn = vi.spyOn(api, 'spawnChild').mockResolvedValue({ child: { id: 'child' } })
    client = new Client({ name: 'test', version: '1' })
    server = buildCodekinMcpServer(api)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  })

  afterEach(async () => {
    await client.close()
    await server.close()
    vi.restoreAllMocks()
  })

  it.each(['claude', 'codex', 'opencode', undefined])('passes %s through the actual tool schema', async (provider) => {
    const args = { repo: '/repo', task: 'fix task', branchName: 'fix/task', ...(provider ? { provider } : {}) }
    const result = await client.callTool({ name: 'spawn_child', arguments: args })
    expect(result.isError).not.toBe(true)
    expect(spawn).toHaveBeenCalledWith(args)
  })

  it('rejects unsupported providers without calling the API', async () => {
    const result = await client.callTool({ name: 'spawn_child', arguments: { repo: '/repo', task: 'fix', branchName: 'fix/task', provider: 'unknown' } })
    expect(result.isError).toBe(true)
    expect(spawn).not.toHaveBeenCalled()
  })
})

describe('Codekin MCP tool registry', () => {
  const api = new CodekinApi({ baseUrl: 'http://unused.test', token: 'test' })
  let client: Client
  let server: ReturnType<typeof buildCodekinMcpServer>

  beforeEach(async () => {
    client = new Client({ name: 'test', version: '1' })
    server = buildCodekinMcpServer(api)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  })

  afterEach(async () => {
    await client.close()
    await server.close()
    vi.restoreAllMocks()
  })

  it('registers exactly the tools pre-approved for Joe', async () => {
    const { ORCHESTRATOR_MCP_TOOL_NAMES } = await import('./orchestrator-manager.js')
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name).sort()).toEqual([...ORCHESTRATOR_MCP_TOOL_NAMES].sort())
  })

  it('maps the child control tools onto the API client', async () => {
    const send = vi.spyOn(api, 'sendToChild').mockResolvedValue({})
    const stop = vi.spyOn(api, 'stopChild').mockResolvedValue({})
    const resume = vi.spyOn(api, 'resumeChild').mockResolvedValue({})
    const close = vi.spyOn(api, 'closeChild').mockResolvedValue({})
    const list = vi.spyOn(api, 'listSessions').mockResolvedValue({ sessions: [] })

    await client.callTool({ name: 'send_to_child', arguments: { id: 'c1', text: 'also update the docs' } })
    await client.callTool({ name: 'stop_child', arguments: { id: 'c1' } })
    await client.callTool({ name: 'resume_child', arguments: { id: 'c1', instructions: 'fix the lint error' } })
    await client.callTool({ name: 'close_child', arguments: { id: 'c1', mode: 'delete', cancel: true } })
    await client.callTool({ name: 'list_sessions', arguments: { source: 'agent', active: true } })

    expect(send).toHaveBeenCalledWith('c1', 'also update the docs')
    expect(stop).toHaveBeenCalledWith('c1')
    expect(resume).toHaveBeenCalledWith('c1', 'fix the lint error')
    expect(close).toHaveBeenCalledWith('c1', { mode: 'delete', cancel: true })
    expect(list).toHaveBeenCalledWith({ source: 'agent', active: true })
  })

  it('accepts one answer per question in respond_to_prompt', async () => {
    const respond = vi.spyOn(api, 'respondToPrompt').mockResolvedValue({ ok: true })
    const result = await client.callTool({ name: 'respond_to_prompt', arguments: { sessionId: 's', requestId: 'r', value: ['Yes', 'Postgres'] } })
    expect(result.isError).not.toBe(true)
    expect(respond).toHaveBeenCalledWith('s', 'r', ['Yes', 'Postgres'])
  })

  it('rejects an empty follow-up without calling the API', async () => {
    const send = vi.spyOn(api, 'sendToChild').mockResolvedValue({})
    const result = await client.callTool({ name: 'send_to_child', arguments: { id: 'c1', text: '' } })
    expect(result.isError).toBe(true)
    expect(send).not.toHaveBeenCalled()
  })
})
