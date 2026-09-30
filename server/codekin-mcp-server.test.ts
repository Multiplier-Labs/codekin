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
