/**
 * Tests for GrokProcess — the ACP handshake, session/update → process event
 * mapping, approval round-trips, resume replay suppression, and lifecycle.
 * The `grok agent stdio` child is mocked with an EventEmitter + PassThrough
 * stdout so NDJSON lines can be fed in; message shapes mirror grok 1.0.44.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'

interface MockProc extends EventEmitter {
  stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; writable: boolean; end: ReturnType<typeof vi.fn> }
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
  killed: boolean
  exitCode: number | null
}

const spawnState = vi.hoisted(() => ({
  procs: [] as unknown[],
  calls: [] as Array<{ binary: string; args: string[]; opts: { env?: Record<string, string>; cwd?: string } }>,
}))

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  const { EventEmitter } = await import('events')
  const { PassThrough } = await import('stream')
  return {
    ...actual,
    spawn: vi.fn((binary: string, args: string[], opts: { env?: Record<string, string>; cwd?: string }) => {
      const proc = Object.assign(new EventEmitter(), {
        stdin: Object.assign(new EventEmitter(), { write: vi.fn(), writable: true, end: vi.fn() }),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(),
        killed: false,
        exitCode: null,
      })
      spawnState.procs.push(proc)
      spawnState.calls.push({ binary, args, opts })
      return proc
    }),
  }
})

import { GrokProcess, fetchGrokModels, clearGrokModelCache } from './grok-process.js'
import { GROK_CAPABILITIES } from './coding-process.js'
import { tmpdir } from 'os'

const tick = async () => {
  for (let i = 0; i < 4; i++) await new Promise<void>(r => setImmediate(r))
}

const lastProc = (): MockProc => spawnState.procs[spawnState.procs.length - 1] as MockProc

type Msg = { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown }

const writes = (proc: MockProc): Msg[] =>
  proc.stdin.write.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string) as Msg)

const feed = async (proc: MockProc, msg: Record<string, unknown>) => {
  proc.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
  await tick()
}

/** Last client→agent request with this method. */
const lastRequest = (proc: MockProc, method: string): Msg => {
  const found = writes(proc).filter(m => m.method === method && m.id !== undefined).pop()
  if (!found) throw new Error(`no ${method} request written`)
  return found
}

const respond = (proc: MockProc, method: string, result: unknown) =>
  feed(proc, { id: lastRequest(proc, method).id, result })

const update = (proc: MockProc, u: Record<string, unknown>) =>
  feed(proc, { method: 'session/update', params: { sessionId: 'sid-1', update: u } })

const MODELS = {
  currentModelId: 'grok-4.7',
  availableModels: [{ modelId: 'grok-4.7', name: 'Grok 4.7' }, { modelId: 'grok-4.6', name: 'Grok 4.6' }],
}

/** Drive initialize → session/new → set_mode → mode ack. */
async function handshake(proc: MockProc, opts: { mode?: 'default' | 'plan' } = {}) {
  await tick()
  await respond(proc, 'initialize', { protocolVersion: 1, agentCapabilities: { loadSession: true } })
  await respond(proc, 'session/new', { sessionId: 'sid-1', models: MODELS })
  await respond(proc, 'session/set_mode', {})
  await update(proc, { sessionUpdate: 'current_mode_update', currentModeId: opts.mode ?? 'default' })
}

const WORKDIR = tmpdir()

describe('GrokProcess', () => {
  beforeEach(() => {
    spawnState.procs.length = 0
    spawnState.calls.length = 0
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('declares the grok provider and capabilities', () => {
    const gp = new GrokProcess(WORKDIR)
    expect(gp.provider).toBe('grok')
    expect(gp.capabilities).toBe(GROK_CAPABILITIES)
  })

  it('spawns `grok agent --no-leader stdio` with Claude hooks disabled and no inherited GIT_*', () => {
    vi.stubEnv('GIT_INDEX_FILE', '.git/index')
    const gp = new GrokProcess(WORKDIR, { extraEnv: { CODEKIN_TOKEN: 'scoped', GROK_CLAUDE_HOOKS_ENABLED: 'true' } })
    gp.start()
    const call = spawnState.calls[0]
    expect(call.args).toEqual(['agent', '--no-leader', 'stdio'])
    expect(call.opts.cwd).toBe(WORKDIR)
    expect(call.opts.env?.GROK_CLAUDE_HOOKS_ENABLED).toBe('false')
    expect(call.opts.env?.CODEKIN_TOKEN).toBe('scoped')
    expect(call.opts.env?.GIT_INDEX_FILE).toBeUndefined()
    vi.unstubAllEnvs()
    gp.stop()
  })

  it('initializes with no client capabilities, creates a session, and reports ready', async () => {
    const gp = new GrokProcess(WORKDIR)
    const inits: string[] = []
    gp.on('system_init', (m) => inits.push(m))
    gp.start()
    const proc = lastProc()
    await handshake(proc)

    expect(lastRequest(proc, 'initialize').params).toEqual({ protocolVersion: 1, clientCapabilities: {} })
    expect(lastRequest(proc, 'session/new').params).toEqual({ cwd: WORKDIR, mcpServers: [] })
    expect(lastRequest(proc, 'session/set_mode').params).toEqual({ sessionId: 'sid-1', modeId: 'default' })
    expect(gp.isReady()).toBe(true)
    expect(gp.getSessionId()).toBe('sid-1')
    expect(inits).toEqual(['grok-4.7'])
    gp.stop()
  })

  it('rejects an unsupported protocol version', async () => {
    const gp = new GrokProcess(WORKDIR)
    const errors: string[] = []
    gp.on('error', (e) => errors.push(e))
    gp.start()
    const proc = lastProc()
    await tick()
    await respond(proc, 'initialize', { protocolVersion: 2 })
    expect(errors.join('\n')).toMatch(/unsupported ACP protocol version 2/)
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('reports an auth failure as non-retryable with a login hint', async () => {
    const gp = new GrokProcess(WORKDIR)
    const errors: string[] = []
    gp.on('error', (e) => errors.push(e))
    gp.start()
    const proc = lastProc()
    await tick()
    await feed(proc, { id: lastRequest(proc, 'initialize').id, error: { code: -32000, message: 'Authentication required' } })
    expect(errors.join('\n')).toMatch(/grok login/)
    expect(gp.hasSessionConflict()).toBe(true)
  })

  it('passes yoloMode on session/new for bypass modes', async () => {
    const gp = new GrokProcess(WORKDIR, { permissionMode: 'bypassPermissions' })
    gp.start()
    const proc = lastProc()
    await handshake(proc)
    expect(lastRequest(proc, 'session/new').params).toEqual({ cwd: WORKDIR, mcpServers: [], _meta: { yoloMode: true } })
    gp.stop()
  })

  it('switches to the requested model after the session opens', async () => {
    const gp = new GrokProcess(WORKDIR, { model: 'grok-4.6' })
    const inits: string[] = []
    gp.on('system_init', (m) => inits.push(m))
    gp.start()
    const proc = lastProc()
    await tick()
    await respond(proc, 'initialize', { protocolVersion: 1 })
    await respond(proc, 'session/new', { sessionId: 'sid-1', models: MODELS })
    expect(lastRequest(proc, 'session/set_config_option').params).toEqual({ sessionId: 'sid-1', configId: 'model', value: 'grok-4.6' })
    await respond(proc, 'session/set_config_option', { configOptions: [] })
    await respond(proc, 'session/set_mode', {})
    await update(proc, { sessionUpdate: 'current_mode_update', currentModeId: 'default' })
    expect(inits).toEqual(['grok-4.6'])
    gp.stop()
  })

  it('loads a stored session and drops the replayed history', async () => {
    const gp = new GrokProcess(WORKDIR, { grokSessionId: 'sid-old' })
    const texts: string[] = []
    const tools: string[] = []
    gp.on('text', (t) => texts.push(t))
    gp.on('tool_active', (n) => tools.push(n))
    gp.on('result', () => { throw new Error('replay must not emit result') })
    gp.start()
    const proc = lastProc()
    await tick()
    await respond(proc, 'initialize', { protocolVersion: 1 })
    expect(lastRequest(proc, 'session/load').params).toEqual({ cwd: WORKDIR, mcpServers: [], sessionId: 'sid-old' })
    // Replay arrives before the load response.
    await update(proc, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'earlier prompt' } })
    await update(proc, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'earlier answer' } })
    await update(proc, { sessionUpdate: 'tool_call', toolCallId: 'c-old', title: 'Execute `ls`', kind: 'execute', status: 'completed', rawInput: { variant: 'Bash', command: 'ls' } })
    await respond(proc, 'session/load', { models: MODELS })
    await respond(proc, 'session/set_mode', {})
    await update(proc, { sessionUpdate: 'current_mode_update', currentModeId: 'default' })

    expect(texts).toEqual([])
    expect(tools).toEqual([])
    expect(gp.getSessionId()).toBe('sid-old')
    expect(gp.isReady()).toBe(true)
    gp.stop()
  })

  it('falls back to a fresh session when the stored one cannot be loaded', async () => {
    const gp = new GrokProcess(WORKDIR, { grokSessionId: 'sid-gone' })
    const errors: string[] = []
    gp.on('error', (e) => errors.push(e))
    gp.start()
    const proc = lastProc()
    await tick()
    await respond(proc, 'initialize', { protocolVersion: 1 })
    await feed(proc, { id: lastRequest(proc, 'session/load').id, error: { code: -32602, message: 'Invalid params', data: 'session not found' } })
    await respond(proc, 'session/new', { sessionId: 'sid-new', models: MODELS })
    await respond(proc, 'session/set_mode', {})
    await update(proc, { sessionUpdate: 'current_mode_update', currentModeId: 'default' })
    expect(errors.join('\n')).toMatch(/Could not resume.*session not found/)
    expect(gp.getSessionId()).toBe('sid-new')
    gp.stop()
  })

  it('streams a turn: text, thinking, tool events, usage, then one result', async () => {
    const gp = new GrokProcess(WORKDIR)
    const events: string[] = []
    gp.on('text', (t) => events.push(`text:${t}`))
    gp.on('thinking', (t) => events.push(`thinking:${t}`))
    gp.on('tool_active', (n, s) => events.push(`active:${n}:${s}`))
    gp.on('tool_done', (n, s) => events.push(`done:${n}:${s}`))
    gp.on('tool_output', (c, e) => events.push(`output:${c}:${e}`))
    gp.on('usage', (u) => events.push(`usage:${u.inputTokens}/${u.outputTokens}/${u.costUsd}`))
    gp.on('result', (t, e) => events.push(`result:${t}:${e}`))
    gp.start()
    const proc = lastProc()
    await handshake(proc)

    gp.sendMessage('list files')
    expect(lastRequest(proc, 'session/prompt').params).toEqual({ sessionId: 'sid-1', prompt: [{ type: 'text', text: 'list files' }] })

    await update(proc, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'I will list the files first. Then summarize.' } })
    await update(proc, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: "I'll list them." } })
    await update(proc, {
      sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'run_terminal_command',
      rawInput: { command: 'ls', description: 'List files' },
      _meta: { 'x.ai/tool': { name: 'run_terminal_command', kind: 'execute' } },
    })
    await update(proc, { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text: '' } }] })
    await update(proc, { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'a.txt\nb.txt\n' } }] })
    await update(proc, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Two files.' } })
    await respond(proc, 'session/prompt', { stopReason: 'end_turn', _meta: { usage: { inputTokens: 100, outputTokens: 20, costUsdTicks: 1e8 } } })

    expect(events).toEqual([
      'thinking:I will list the files first.',
      "text:I'll list them.",
      'active:Bash:$ ls',
      'done:Bash:a.txt\nb.txt\n',
      'output:a.txt\nb.txt\n:false',
      'text:Two files.',
      'usage:100/20/0.01',
      'result::false',
    ])
    gp.stop()
  })

  it('reports diff paths for edits and does not echo file reads into the transcript', async () => {
    const gp = new GrokProcess(WORKDIR)
    const events: string[] = []
    gp.on('tool_done', (n, s) => events.push(`done:${n}:${s}`))
    gp.on('tool_output', (c) => events.push(`output:${c}`))
    gp.start()
    const proc = lastProc()
    await handshake(proc)
    gp.sendMessage('edit')

    await update(proc, { sessionUpdate: 'tool_call', toolCallId: 'r1', title: 'read_file', rawInput: { target_file: '/r/f.txt' }, _meta: { 'x.ai/tool': { name: 'read_file', kind: 'read' } } })
    await update(proc, { sessionUpdate: 'tool_call_update', toolCallId: 'r1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '1→alpha' } }] })
    await update(proc, { sessionUpdate: 'tool_call', toolCallId: 'e1', title: 'search_replace', rawInput: { file_path: '/r/f.txt', old_string: 'a', new_string: 'b' }, _meta: { 'x.ai/tool': { name: 'search_replace', kind: 'edit' } } })
    await update(proc, { sessionUpdate: 'tool_call_update', toolCallId: 'e1', status: 'completed', content: [{ type: 'diff', path: '/r/f.txt', oldText: 'a', newText: 'b' }] })

    expect(events).toEqual(['done:Read:1→alpha', 'done:Edit:/r/f.txt'])
    gp.stop()
  })

  it('bridges permission requests to control_request and answers with the offered option', async () => {
    const gp = new GrokProcess(WORKDIR)
    const requests: Array<[string, string, Record<string, unknown>]> = []
    gp.on('control_request', (id, name, input) => requests.push([id, name, input]))
    gp.start()
    const proc = lastProc()
    await handshake(proc)
    gp.sendMessage('clean up')

    const options = [
      { optionId: 'always-allow', kind: 'allow_always' },
      { optionId: 'allow-once', kind: 'allow_once' },
      { optionId: 'reject-once', kind: 'reject_once' },
    ]
    await feed(proc, {
      id: 0, method: 'session/request_permission',
      params: { sessionId: 'sid-1', toolCall: { toolCallId: 'c1', kind: 'execute', title: 'Execute `rm -f x`', rawInput: { variant: 'Bash', command: 'rm -f x' } }, options },
    })
    await feed(proc, {
      id: 1, method: 'session/request_permission',
      params: { sessionId: 'sid-1', toolCall: { toolCallId: 'c2', kind: 'edit', rawInput: { variant: 'Write', file_path: '/r/x.txt' } }, options },
    })
    expect(requests).toEqual([
      ['grok-approval-0', 'Bash', { command: 'rm -f x' }],
      ['grok-approval-1', 'Write', { file_path: '/r/x.txt' }],
    ])

    gp.sendControlResponse('grok-approval-0', 'allow_always')
    gp.sendControlResponse('grok-approval-1', 'deny')
    const replies = writes(proc).filter(m => m.method === undefined && m.result !== undefined)
    expect(replies).toEqual([
      { jsonrpc: '2.0', id: 0, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } },
      { jsonrpc: '2.0', id: 1, result: { outcome: { outcome: 'selected', optionId: 'reject-once' } } },
    ])
    gp.stop()
  })

  it('answers unsupported agent requests with a JSON-RPC error', async () => {
    const gp = new GrokProcess(WORKDIR)
    gp.start()
    const proc = lastProc()
    await handshake(proc)
    await feed(proc, { id: 7, method: 'fs/read_text_file', params: { path: '/etc/passwd' } })
    const reply = writes(proc).find(m => m.id === 7)
    expect(reply?.error).toEqual({ code: -32601, message: 'Codekin does not support fs/read_text_file' })
    gp.stop()
  })

  it('queues messages sent during a turn and dispatches them in order', async () => {
    const gp = new GrokProcess(WORKDIR)
    gp.start()
    const proc = lastProc()
    // Sent before the handshake completes — queued until ready.
    gp.sendMessage('first')
    await handshake(proc)
    expect(writes(proc).filter(m => m.method === 'session/prompt')).toHaveLength(1)
    gp.sendMessage('second')
    expect(writes(proc).filter(m => m.method === 'session/prompt')).toHaveLength(1)
    await respond(proc, 'session/prompt', { stopReason: 'end_turn' })
    const prompts = writes(proc).filter(m => m.method === 'session/prompt')
    expect(prompts.map(p => (p.params?.prompt as Array<{ text: string }>)[0].text)).toEqual(['first', 'second'])
    gp.stop()
  })

  it('closes tools left open when a denied permission ends the turn', async () => {
    const gp = new GrokProcess(WORKDIR)
    const events: string[] = []
    gp.on('tool_done', (n, s) => events.push(`done:${n}:${s}`))
    gp.on('result', (t, e) => events.push(`result:${t}:${e}`))
    gp.start()
    const proc = lastProc()
    await handshake(proc)
    gp.sendMessage('write it')
    await update(proc, { sessionUpdate: 'tool_call', toolCallId: 'w1', title: 'write', rawInput: { file_path: '/r/e.txt' }, _meta: { 'x.ai/tool': { name: 'write', kind: 'write' } } })
    await respond(proc, 'session/prompt', { stopReason: 'cancelled' })
    expect(events).toEqual(['done:Write:Interrupted', 'result::false'])
    gp.stop()
  })

  it('switches plan mode in place and restarts for always-approve changes', async () => {
    const gp = new GrokProcess(WORKDIR)
    gp.start()
    const proc = lastProc()
    await handshake(proc)

    const toPlan = gp.setPermissionMode('plan')
    await tick()
    expect(lastRequest(proc, 'session/set_mode').params).toEqual({ sessionId: 'sid-1', modeId: 'plan' })
    await respond(proc, 'session/set_mode', {})
    await update(proc, { sessionUpdate: 'current_mode_update', currentModeId: 'plan' })
    await expect(toPlan).resolves.toBe(true)

    await expect(gp.setPermissionMode('bypassPermissions')).resolves.toBe(false)
    gp.stop()
  })

  it('treats a set_mode without a current_mode_update as not applied', async () => {
    const gp = new GrokProcess(WORKDIR)
    gp.start()
    const proc = lastProc()
    await handshake(proc)
    // Fake only timeouts — the feed helpers rely on real setImmediate.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const result = gp.setPermissionMode('plan')
    await tick()
    await respond(proc, 'session/set_mode', {})
    await vi.advanceTimersByTimeAsync(6_000)
    await expect(result).resolves.toBe(false)
    vi.useRealTimers()
    gp.stop()
  })

  it('cancels an active turn on stop and terminates the child', async () => {
    const gp = new GrokProcess(WORKDIR)
    gp.start()
    const proc = lastProc()
    await handshake(proc)
    gp.sendMessage('long task')
    gp.stop()
    const cancel = writes(proc).find(m => m.method === 'session/cancel')
    expect(cancel).toEqual({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'sid-1' } })
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('emits an error result and exit when the child dies mid-turn', async () => {
    const gp = new GrokProcess(WORKDIR)
    const events: string[] = []
    gp.on('result', (t, e) => events.push(`result:${t}:${e}`))
    gp.on('exit', (c) => events.push(`exit:${c}`))
    gp.start()
    const proc = lastProc()
    await handshake(proc)
    gp.sendMessage('work')
    proc.emit('close', 1, null)
    await tick()
    expect(events).toEqual(['result:Grok exited unexpectedly mid-turn:true', 'exit:1'])
  })

  it('reports a missing binary with the install hint', async () => {
    const gp = new GrokProcess(WORKDIR)
    const errors: string[] = []
    gp.on('error', (e) => errors.push(e))
    gp.start()
    const err = Object.assign(new Error('spawn grok ENOENT'), { code: 'ENOENT' })
    lastProc().emit('error', err)
    expect(errors[0]).toMatch(/x\.ai\/cli\/install\.sh/)
    expect(gp.hasSpawnFailed()).toBe(true)
  })
})

describe('fetchGrokModels', () => {
  beforeEach(() => {
    spawnState.procs.length = 0
    clearGrokModelCache()
  })

  it('reads models from the initialize response and caches them', async () => {
    const pending = fetchGrokModels()
    await tick()
    const proc = lastProc()
    expect(writes(proc)[0]).toMatchObject({ id: 1, method: 'initialize' })
    await feed(proc, { id: 1, result: { protocolVersion: 1, _meta: { modelState: MODELS } } })
    const { models } = await pending
    expect(models.map(m => [m.id, m.isDefault])).toEqual([['grok-4.7', true], ['grok-4.6', false]])
    expect(proc.kill).toHaveBeenCalled()

    await fetchGrokModels()
    expect(spawnState.procs).toHaveLength(1)
  })

  it('returns an empty list when the child exits early', async () => {
    const pending = fetchGrokModels()
    await tick()
    lastProc().emit('close', 1, null)
    await expect(pending).resolves.toEqual({ models: [] })
  })
})
