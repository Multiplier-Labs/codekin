/**
 * Tests for CodexProcess — verifies the JSON-RPC handshake, app-server
 * notification → ClaudeProcessEvents mapping, approval round-trips, and
 * provider interface compliance. The `codex app-server` child is mocked with
 * an EventEmitter + PassThrough stdout so NDJSON lines can be fed in.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'

interface MockProc extends EventEmitter {
  stdin: { write: ReturnType<typeof vi.fn>; writable: boolean; end: ReturnType<typeof vi.fn> }
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
  killed: boolean
  exitCode: number | null
}

const spawnState = vi.hoisted(() => ({
  procs: [] as unknown[],
  failNext: null as string | null,
}))

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  const { EventEmitter } = await import('events')
  const { PassThrough } = await import('stream')
  return {
    ...actual,
    spawn: vi.fn(() => {
      const proc = Object.assign(new EventEmitter(), {
        stdin: { write: vi.fn(), writable: true, end: vi.fn() },
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(),
        killed: false,
        exitCode: null,
      })
      spawnState.procs.push(proc)
      if (spawnState.failNext) {
        const code = spawnState.failNext
        spawnState.failNext = null
        setImmediate(() => {
          const err = new Error(`spawn codex ${code}`) as NodeJS.ErrnoException
          err.code = code
          proc.emit('error', err)
        })
      }
      return proc
    }),
  }
})

import { CodexProcess, fetchCodexModels, clearCodexModelCache } from './codex-process.js'
import { CODEX_CAPABILITIES } from './coding-process.js'

const tick = async () => {
  await new Promise<void>(r => setImmediate(r))
  await new Promise<void>(r => setImmediate(r))
}

const lastProc = (): MockProc => spawnState.procs[spawnState.procs.length - 1] as MockProc

/** All JSON messages written to the child's stdin so far. */
const writes = (proc: MockProc): Array<Record<string, unknown>> =>
  proc.stdin.write.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string) as Record<string, unknown>)

/** Feed one NDJSON line to the child's stdout. */
const feed = async (proc: MockProc, msg: Record<string, unknown>) => {
  proc.stdout.write(JSON.stringify(msg) + '\n')
  await tick()
}

/** Run the full initialize → thread/start handshake. */
const handshake = async (cxp: CodexProcess, threadId = 'thread-1') => {
  cxp.start()
  const proc = lastProc()
  await tick()
  const init = writes(proc).find(w => w.method === 'initialize')!
  await feed(proc, { id: init.id, result: {} })
  const ts = writes(proc).find(w => w.method === 'thread/start' || w.method === 'thread/resume')!
  await feed(proc, { id: ts.id, result: { thread: { id: threadId } } })
  return proc
}

describe('CodexProcess', () => {
  let cxp: CodexProcess
  let errors: string[]

  beforeEach(() => {
    spawnState.procs = []
    spawnState.failNext = null
    clearCodexModelCache()
    vi.clearAllMocks()
    cxp = new CodexProcess('/tmp', { sessionId: 'test-session-id', model: 'gpt-5.5' })
    errors = []
    cxp.on('error', (msg) => errors.push(msg))
  })

  afterEach(async () => {
    cxp.stop()
    // Settle the close handler so kill/startup timers are cleared
    for (const p of spawnState.procs) (p as MockProc).emit('close', 0, null)
    await tick()
  })

  // ---------------------------------------------------------------------------
  // Interface compliance
  // ---------------------------------------------------------------------------

  describe('provider interface', () => {
    it('reports provider as codex', () => {
      expect(cxp.provider).toBe('codex')
    })

    it('has codex capabilities', () => {
      expect(cxp.capabilities).toBe(CODEX_CAPABILITIES)
      expect(cxp.capabilities.multiProvider).toBe(false)
      expect(cxp.capabilities.planMode).toBe(false)
    })

    it('starts as not alive and not ready', () => {
      expect(cxp.isAlive()).toBe(false)
      expect(cxp.isReady()).toBe(false)
    })

    it('returns codekin session ID when no thread exists', () => {
      expect(cxp.getSessionId()).toBe('test-session-id')
    })

    it('returns the codex thread ID when available (for resume)', () => {
      const cxp2 = new CodexProcess('/tmp', { sessionId: 'ck-id', codexThreadId: 'thread-abc' })
      expect(cxp2.getSessionId()).toBe('thread-abc')
      cxp2.stop()
    })

    it('generates a session ID if not provided', () => {
      const cxp2 = new CodexProcess('/tmp')
      expect(cxp2.getSessionId()).toHaveLength(36)
      cxp2.stop()
    })

    it('sendRaw is a no-op', () => {
      cxp.sendRaw('anything')
    })

    it('waitForExit resolves immediately when not started', async () => {
      await expect(cxp.waitForExit()).resolves.toBeUndefined()
    })
  })

  // ---------------------------------------------------------------------------
  // Startup & handshake
  // ---------------------------------------------------------------------------

  describe('startup handshake', () => {
    it('errors immediately when working directory does not exist', () => {
      const cxp2 = new CodexProcess('/nonexistent/dir/xyz')
      const errs: string[] = []
      const exits: Array<number | null> = []
      cxp2.on('error', (m) => errs.push(m))
      cxp2.on('exit', (code) => exits.push(code))
      cxp2.start()
      expect(errs[0]).toContain('Working directory does not exist')
      expect(exits).toEqual([1])
    })

    it('sends initialize with codekin clientInfo', async () => {
      cxp.start()
      await tick()
      const init = writes(lastProc()).find(w => w.method === 'initialize')!
      expect(init.params).toMatchObject({ clientInfo: { name: 'codekin' } })
    })

    it('sends initialized notification then thread/start with cwd, policy, sandbox, model', async () => {
      cxp.start()
      const proc = lastProc()
      await tick()
      const init = writes(proc).find(w => w.method === 'initialize')!
      await feed(proc, { id: init.id, result: {} })
      const all = writes(proc)
      expect(all.some(w => w.method === 'initialized' && w.id === undefined)).toBe(true)
      const ts = all.find(w => w.method === 'thread/start')!
      expect(ts.params).toMatchObject({
        cwd: '/tmp',
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        model: 'gpt-5.5',
      })
    })

    it('becomes ready and emits system_init after thread/start response', async () => {
      const inits: string[] = []
      cxp.on('system_init', (m) => inits.push(m))
      await handshake(cxp)
      expect(cxp.isAlive()).toBe(true)
      expect(cxp.isReady()).toBe(true)
      expect(cxp.getSessionId()).toBe('thread-1')
      expect(inits).toEqual(['gpt-5.5'])
    })

    it('uses thread/resume when a codexThreadId is provided', async () => {
      const cxp2 = new CodexProcess('/tmp', { codexThreadId: 'thread-old' })
      cxp2.on('error', () => {})
      cxp2.start()
      const proc = lastProc()
      await tick()
      const init = writes(proc).find(w => w.method === 'initialize')!
      await feed(proc, { id: init.id, result: {} })
      const resume = writes(proc).find(w => w.method === 'thread/resume')!
      expect(resume.params).toMatchObject({ threadId: 'thread-old' })
      cxp2.stop()
    })

    it('maps bypassPermissions to never/danger-full-access', async () => {
      const cxp2 = new CodexProcess('/tmp', { permissionMode: 'bypassPermissions' })
      cxp2.on('error', () => {})
      cxp2.start()
      const proc = lastProc()
      await tick()
      const init = writes(proc).find(w => w.method === 'initialize')!
      await feed(proc, { id: init.id, result: {} })
      const ts = writes(proc).find(w => w.method === 'thread/start')!
      expect(ts.params).toMatchObject({ approvalPolicy: 'never', sandbox: 'danger-full-access' })
      cxp2.stop()
    })

    it('maps plan mode to on-request/read-only', async () => {
      const cxp2 = new CodexProcess('/tmp', { permissionMode: 'plan' })
      cxp2.on('error', () => {})
      cxp2.start()
      const proc = lastProc()
      await tick()
      const init = writes(proc).find(w => w.method === 'initialize')!
      await feed(proc, { id: init.id, result: {} })
      const ts = writes(proc).find(w => w.method === 'thread/start')!
      expect(ts.params).toMatchObject({ approvalPolicy: 'on-request', sandbox: 'read-only' })
      cxp2.stop()
    })

    it('surfaces auth errors from the handshake as a codex login hint', async () => {
      cxp.start()
      const proc = lastProc()
      await tick()
      const init = writes(proc).find(w => w.method === 'initialize')!
      await feed(proc, { id: init.id, error: { code: 401, message: 'unauthorized: not logged in' } })
      expect(errors.some(e => e.includes('codex login'))).toBe(true)
      expect(cxp.hasSessionConflict()).toBe(true)
    })

    it('reports ENOENT spawn failure with install hint', async () => {
      spawnState.failNext = 'ENOENT'
      const exits: Array<number | null> = []
      cxp.on('exit', (code) => exits.push(code))
      cxp.start()
      await tick()
      expect(errors.some(e => e.includes('npm install -g @openai/codex'))).toBe(true)
      expect(exits).toEqual([1])
      expect(cxp.hasSpawnFailed()).toBe(true)
      expect(cxp.isAlive()).toBe(false)
    })

    it('skips non-JSON banner lines on stdout', async () => {
      cxp.start()
      const proc = lastProc()
      await tick()
      proc.stdout.write('codex app-server starting...\n')
      await tick()
      expect(errors).toEqual([])
      expect(cxp.hadOutput()).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // Notification → event mapping
  // ---------------------------------------------------------------------------

  describe('event mapping', () => {
    let proc: MockProc

    beforeEach(async () => {
      proc = await handshake(cxp)
    })

    it('maps item/agentMessage/delta to text events', async () => {
      const texts: string[] = []
      cxp.on('text', (t) => texts.push(t))
      await feed(proc, { method: 'item/agentMessage/delta', params: { delta: 'Hello ' } })
      await feed(proc, { method: 'item/agentMessage/delta', params: { delta: 'world' } })
      expect(texts).toEqual(['Hello ', 'world'])
    })

    it('emits full text from item/completed only when no deltas streamed', async () => {
      const texts: string[] = []
      cxp.on('text', (t) => texts.push(t))
      await feed(proc, { method: 'item/completed', params: { item: { type: 'agentMessage', id: 'i1', text: 'Full reply' } } })
      expect(texts).toEqual(['Full reply'])
    })

    it('does not duplicate text when deltas were streamed', async () => {
      const texts: string[] = []
      cxp.on('text', (t) => texts.push(t))
      cxp.sendMessage('hi')
      await tick()
      await feed(proc, { method: 'item/agentMessage/delta', params: { delta: 'Streamed' } })
      await feed(proc, { method: 'item/completed', params: { item: { type: 'agentMessage', id: 'i1', text: 'Streamed' } } })
      expect(texts).toEqual(['Streamed'])
    })

    it('buffers reasoning summary deltas into a single thinking event per item', async () => {
      const thoughts: string[] = []
      cxp.on('thinking', (t) => thoughts.push(t))
      await feed(proc, { method: 'item/reasoning/summaryTextDelta', params: { itemId: 'r1', delta: 'Considering the' } })
      await feed(proc, { method: 'item/reasoning/summaryTextDelta', params: { itemId: 'r1', delta: ' best approach.' } })
      await feed(proc, { method: 'item/reasoning/summaryTextDelta', params: { itemId: 'r1', delta: ' More text after.' } })
      expect(thoughts).toHaveLength(1)
    })

    it('falls back to completed reasoning summary when no deltas streamed', async () => {
      const thoughts: string[] = []
      cxp.on('thinking', (t) => thoughts.push(t))
      await feed(proc, { method: 'item/completed', params: { item: { type: 'reasoning', id: 'r1', summary: ['Planning the change.'] } } })
      expect(thoughts).toEqual(['Planning the change.'])
    })

    it('maps commandExecution lifecycle to Bash tool events', async () => {
      const active: Array<[string, string | undefined]> = []
      const done: Array<[string, string | undefined]> = []
      const outputs: Array<[string, boolean]> = []
      cxp.on('tool_active', (name, detail) => active.push([name, detail]))
      cxp.on('tool_done', (name, summary) => done.push([name, summary]))
      cxp.on('tool_output', (out, failed) => outputs.push([out, failed]))

      await feed(proc, { method: 'item/started', params: { item: { type: 'commandExecution', id: 'c1', command: 'ls -la' } } })
      await feed(proc, { method: 'item/completed', params: { item: { type: 'commandExecution', id: 'c1', command: 'ls -la', status: 'completed', aggregatedOutput: 'total 0', exitCode: 0 } } })

      expect(active[0][0]).toBe('Bash')
      expect(done[0][0]).toBe('Bash')
      expect(outputs).toEqual([['total 0', false]])
    })

    it('marks failed command output as failed', async () => {
      const outputs: Array<[string, boolean]> = []
      cxp.on('tool_output', (out, failed) => outputs.push([out, failed]))
      await feed(proc, { method: 'item/completed', params: { item: { type: 'commandExecution', id: 'c1', status: 'failed', aggregatedOutput: 'boom', exitCode: 1 } } })
      expect(outputs).toEqual([['boom', true]])
    })

    it('truncates long command output to 2000 chars', async () => {
      const outputs: string[] = []
      cxp.on('tool_output', (out) => outputs.push(out))
      const big = 'x'.repeat(5000)
      await feed(proc, { method: 'item/completed', params: { item: { type: 'commandExecution', id: 'c1', status: 'completed', aggregatedOutput: big, exitCode: 0 } } })
      expect(outputs[0].length).toBeLessThan(2100)
      expect(outputs[0]).toContain('truncated, 5000 chars total')
    })

    it('maps fileChange items to Edit tool events with paths', async () => {
      const active: Array<[string, string | undefined]> = []
      const done: Array<[string, string | undefined]> = []
      cxp.on('tool_active', (name, detail) => active.push([name, detail]))
      cxp.on('tool_done', (name, summary) => done.push([name, summary]))
      const changes = [{ path: 'src/a.ts', kind: 'edit', diff: '' }, { path: 'src/b.ts', kind: 'add', diff: '' }]
      await feed(proc, { method: 'item/started', params: { item: { type: 'fileChange', id: 'f1', changes } } })
      await feed(proc, { method: 'item/completed', params: { item: { type: 'fileChange', id: 'f1', status: 'completed', changes } } })
      expect(active).toEqual([['Edit', 'src/a.ts, src/b.ts']])
      expect(done).toEqual([['Edit', 'src/a.ts, src/b.ts']])
    })

    it('maps mcpToolCall and webSearch items', async () => {
      const active: Array<[string, string | undefined]> = []
      cxp.on('tool_active', (name, detail) => active.push([name, detail]))
      await feed(proc, { method: 'item/started', params: { item: { type: 'mcpToolCall', id: 'm1', tool: 'search_issues', server: 'github' } } })
      await feed(proc, { method: 'item/started', params: { item: { type: 'webSearch', id: 'w1', query: 'vitest docs' } } })
      expect(active).toEqual([['search_issues', 'github'], ['WebSearch', 'vitest docs']])
    })

    it('maps turn/plan/updated to todo_update with normalized statuses', async () => {
      const updates: Array<Array<{ id: string; subject: string; status: string }>> = []
      cxp.on('todo_update', (tasks) => updates.push(tasks))
      await feed(proc, {
        method: 'turn/plan/updated',
        params: {
          plan: [
            { step: 'Read files', status: 'completed' },
            { step: 'Write code', status: 'inProgress' },
            { step: 'Run tests', status: 'pending' },
          ],
        },
      })
      expect(updates[0]).toEqual([
        { id: '1', subject: 'Read files', status: 'completed' },
        { id: '2', subject: 'Write code', status: 'in_progress' },
        { id: '3', subject: 'Run tests', status: 'pending' },
      ])
    })

    it('maps turn/completed to a success result', async () => {
      const results: Array<[string, boolean]> = []
      cxp.on('result', (msg, isError) => results.push([msg, isError]))
      await feed(proc, { method: 'turn/completed', params: { turn: { status: 'completed' } } })
      expect(results).toEqual([['', false]])
    })

    it('maps failed turn/completed to an error result', async () => {
      const results: Array<[string, boolean]> = []
      cxp.on('result', (msg, isError) => results.push([msg, isError]))
      await feed(proc, { method: 'turn/completed', params: { turn: { status: 'failed', error: { message: 'model exploded' } } } })
      expect(results).toEqual([['model exploded', true]])
    })

    it('maps usageLimitExceeded errors to rate_limit + error', async () => {
      const rateLimits: unknown[] = []
      cxp.on('rate_limit', (e) => rateLimits.push(e))
      await feed(proc, { method: 'error', params: { error: { message: 'usage limit reached', codexErrorInfo: 'usageLimitExceeded' } } })
      expect(rateLimits).toHaveLength(1)
      expect(errors).toContain('usage limit reached')
    })

    it('flags unauthorized errors as non-retryable auth failures', async () => {
      await feed(proc, { method: 'error', params: { error: { message: 'token expired', codexErrorInfo: 'unauthorized' } } })
      expect(cxp.hasSessionConflict()).toBe(true)
      expect(errors.some(e => e.includes('codex login'))).toBe(true)
    })

    it('suppresses transient errors that will be retried', async () => {
      await feed(proc, { method: 'error', params: { error: { message: 'flaky network' }, willRetry: true } })
      expect(errors).toEqual([])
    })
  })

  // ---------------------------------------------------------------------------
  // Sending messages / turns
  // ---------------------------------------------------------------------------

  describe('sendMessage', () => {
    it('errors when the process is not running', () => {
      cxp.sendMessage('hello')
      expect(errors).toEqual(['Codex process is not running'])
    })

    it('starts a turn with a snake_case text part', async () => {
      const proc = await handshake(cxp)
      cxp.sendMessage('do the thing')
      await tick()
      const turn = writes(proc).find(w => w.method === 'turn/start')!
      expect(turn.params).toMatchObject({
        threadId: 'thread-1',
        input: [{ type: 'text', text: 'do the thing', text_elements: [] }],
      })
    })

    it('queues messages sent before the handshake completes', async () => {
      cxp.start()
      const proc = lastProc()
      await tick()
      cxp.sendMessage('early message')
      expect(writes(proc).find(w => w.method === 'turn/start')).toBeUndefined()

      const init = writes(proc).find(w => w.method === 'initialize')!
      await feed(proc, { id: init.id, result: {} })
      const ts = writes(proc).find(w => w.method === 'thread/start')!
      await feed(proc, { id: ts.id, result: { thread: { id: 'thread-1' } } })

      const turn = writes(proc).find(w => w.method === 'turn/start')!
      expect(turn.params).toMatchObject({ input: [{ type: 'text', text: 'early message', text_elements: [] }] })
    })

    it('queues messages while a turn is active and dispatches after completion', async () => {
      const proc = await handshake(cxp)
      cxp.sendMessage('first')
      await tick()
      cxp.sendMessage('second')
      await tick()
      expect(writes(proc).filter(w => w.method === 'turn/start')).toHaveLength(1)

      await feed(proc, { method: 'turn/completed', params: { turn: { status: 'completed' } } })
      const turns = writes(proc).filter(w => w.method === 'turn/start')
      expect(turns).toHaveLength(2)
      expect((turns[1].params as { input: Array<{ text: string }> }).input[0].text).toBe('second')
    })

    it('surfaces turn/start failures as error + result', async () => {
      const proc = await handshake(cxp)
      const results: Array<[string, boolean]> = []
      cxp.on('result', (msg, isError) => results.push([msg, isError]))
      cxp.sendMessage('hello')
      await tick()
      const turn = writes(proc).find(w => w.method === 'turn/start')!
      await feed(proc, { id: turn.id, error: { message: 'thread is busy' } })
      expect(results).toEqual([['thread is busy', true]])
      expect(errors.some(e => e.includes('thread is busy'))).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // Approval round-trips
  // ---------------------------------------------------------------------------

  describe('approvals', () => {
    let proc: MockProc

    beforeEach(async () => {
      proc = await handshake(cxp)
    })

    it('surfaces command approval requests as control_request with Bash tool', async () => {
      const requests: Array<[string, string, Record<string, unknown>]> = []
      cxp.on('control_request', (id, tool, input) => requests.push([id, tool, input]))
      await feed(proc, {
        id: 99,
        method: 'item/commandExecution/requestApproval',
        params: { command: 'rm -rf node_modules', cwd: '/tmp', reason: 'cleanup' },
      })
      expect(requests).toEqual([[
        'codex-approval-99',
        'Bash',
        { command: 'rm -rf node_modules', cwd: '/tmp', reason: 'cleanup' },
      ]])
    })

    it('answers allow with an accept decision on the original RPC id', async () => {
      cxp.on('control_request', () => {})
      await feed(proc, { id: 99, method: 'item/commandExecution/requestApproval', params: { command: 'ls' } })
      cxp.sendControlResponse('codex-approval-99', 'allow')
      const reply = writes(proc).find(w => w.id === 99)!
      expect(reply.result).toEqual({ decision: 'accept' })
    })

    it('answers deny with a decline decision', async () => {
      cxp.on('control_request', () => {})
      await feed(proc, { id: 100, method: 'item/fileChange/requestApproval', params: {} })
      cxp.sendControlResponse('codex-approval-100', 'deny')
      const reply = writes(proc).find(w => w.id === 100)!
      expect(reply.result).toEqual({ decision: 'decline' })
    })

    it('surfaces fileChange approvals as Edit control_requests', async () => {
      const requests: Array<[string, string]> = []
      cxp.on('control_request', (id, tool) => requests.push([id, tool]))
      await feed(proc, { id: 7, method: 'item/fileChange/requestApproval', params: { reason: 'write file' } })
      expect(requests).toEqual([['codex-approval-7', 'Edit']])
    })

    it('ignores responses for unknown approval ids', () => {
      cxp.sendControlResponse('codex-approval-12345', 'allow')
      expect(writes(proc).find(w => w.id === 12345)).toBeUndefined()
    })

    it('rejects unsupported server-initiated requests so the turn does not hang', async () => {
      await feed(proc, { id: 55, method: 'item/tool/requestUserInput', params: {} })
      const reply = writes(proc).find(w => w.id === 55)!
      expect(reply.error).toMatchObject({ code: -32601 })
    })

    it('auto-accepts fileChange approvals in acceptEdits mode', async () => {
      const cxp2 = new CodexProcess('/tmp', { permissionMode: 'acceptEdits' })
      cxp2.on('error', () => {})
      const requests: string[] = []
      cxp2.on('control_request', (id) => requests.push(id))
      const proc2 = await handshake(cxp2)
      await feed(proc2, { id: 8, method: 'item/fileChange/requestApproval', params: {} })
      expect(requests).toEqual([])
      expect(writes(proc2).find(w => w.id === 8)!.result).toEqual({ decision: 'accept' })
      // Command approvals still surface in acceptEdits mode
      await feed(proc2, { id: 9, method: 'item/commandExecution/requestApproval', params: { command: 'ls' } })
      expect(requests).toEqual(['codex-approval-9'])
      cxp2.stop()
    })
  })

  // ---------------------------------------------------------------------------
  // Lifecycle: stop & crash
  // ---------------------------------------------------------------------------

  describe('lifecycle', () => {
    it('emits an error result when the process crashes mid-turn', async () => {
      const proc = await handshake(cxp)
      const results: Array<[string, boolean]> = []
      const exits: Array<number | null> = []
      cxp.on('result', (msg, isError) => results.push([msg, isError]))
      cxp.on('exit', (code) => exits.push(code))

      cxp.sendMessage('long task')
      await tick()
      proc.emit('close', 137, null)
      await tick()

      expect(results).toEqual([['Codex exited unexpectedly mid-turn', true]])
      expect(exits).toEqual([137])
      expect(cxp.isAlive()).toBe(false)
    })

    it('sends turn/interrupt and SIGTERM on stop during an active turn', async () => {
      const proc = await handshake(cxp)
      cxp.sendMessage('task')
      await tick()
      await feed(proc, { method: 'turn/started', params: { turn: { id: 'turn-9' } } })
      cxp.stop()
      const interrupt = writes(proc).find(w => w.method === 'turn/interrupt')!
      expect(interrupt.params).toMatchObject({ threadId: 'thread-1', turnId: 'turn-9' })
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
    })

    it('settles pending requests and emits exit when the process closes mid-handshake', async () => {
      const exits: Array<number | null> = []
      cxp.on('exit', (code) => exits.push(code))
      cxp.start()
      const proc = lastProc()
      await tick()
      proc.emit('close', 1, null)
      await tick()
      // The pending initialize() promise is rejected (no unhandled rejection),
      // and the error is suppressed in favor of the exit event.
      expect(exits).toEqual([1])
      expect(cxp.isAlive()).toBe(false)
      expect(errors).toEqual([])
    })

    it('hadOutput reflects whether valid JSON was received', async () => {
      cxp.start()
      const proc = lastProc()
      await tick()
      expect(cxp.hadOutput()).toBe(false)
      await feed(proc, { method: 'thread/started', params: { thread: { id: 't' } } })
      expect(cxp.hadOutput()).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// fetchCodexModels
// ---------------------------------------------------------------------------

describe('fetchCodexModels', () => {
  beforeEach(() => {
    spawnState.procs = []
    spawnState.failNext = null
    clearCodexModelCache()
    vi.clearAllMocks()
  })

  const tickLocal = async () => {
    await new Promise<void>(r => setImmediate(r))
    await new Promise<void>(r => setImmediate(r))
  }

  it('runs initialize → model/list and maps the response', async () => {
    const promise = fetchCodexModels()
    await tickLocal()
    const proc = spawnState.procs[0] as MockProc
    proc.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\n')
    await tickLocal()
    proc.stdout.write(JSON.stringify({
      id: 2,
      result: {
        data: [
          { id: 'gpt-5.5', displayName: 'GPT-5.5', description: 'Frontier', isDefault: true },
          { id: 'gpt-5.4-mini', displayName: 'GPT-5.4 Mini', description: 'Fast', isDefault: false },
        ],
      },
    }) + '\n')
    await tickLocal()
    const result = await promise
    expect(result.models).toEqual([
      { id: 'gpt-5.5', name: 'GPT-5.5', description: 'Frontier', isDefault: true },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', description: 'Fast', isDefault: false },
    ])
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('caches a successful result (no second spawn)', async () => {
    const promise = fetchCodexModels()
    await tickLocal()
    const proc = spawnState.procs[0] as MockProc
    proc.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\n')
    await tickLocal()
    proc.stdout.write(JSON.stringify({ id: 2, result: { data: [{ id: 'm', displayName: 'M', description: '', isDefault: true }] } }) + '\n')
    await tickLocal()
    await promise

    const spawnedBefore = spawnState.procs.length
    const second = await fetchCodexModels()
    expect(second.models).toHaveLength(1)
    expect(spawnState.procs.length).toBe(spawnedBefore)
  })

  it('returns an empty list when the binary is missing', async () => {
    spawnState.failNext = 'ENOENT'
    const promise = fetchCodexModels()
    await tickLocal()
    const result = await promise
    expect(result.models).toEqual([])
  })

  it('returns an empty list when the server exits early', async () => {
    const promise = fetchCodexModels()
    await tickLocal()
    const proc = spawnState.procs[0] as MockProc
    proc.emit('close', 1, null)
    const result = await promise
    expect(result.models).toEqual([])
  })
})
