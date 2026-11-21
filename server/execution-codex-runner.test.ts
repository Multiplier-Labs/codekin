import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  CodexRunner, type RateLimitSnapshot, parseEnabledFeatures, parseMcpServerNames, billingModeFor, mapTurnError, parseRateLimits, type RunSpec,
} from './execution-codex-runner.js'

/**
 * A fake `codex` CLI: `--version`, `features list`, and an `app-server` that
 * speaks just enough JSON-RPC. FAKE_MODE picks the turn's behavior; every
 * argv and request is appended to FAKE_LOG for assertions.
 */
const FAKE = String.raw`
const fs = require('fs')
const log = (o) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + '\n')
const argv = process.argv.slice(2)
if (argv[0] === '--version') { console.log('codex-cli 9.9.9'); process.exit(0) }
if (argv[0] === 'features') {
  console.log('shell_tool                stable   true')
  console.log('apps                      stable   true')
  console.log('memories                  stable   false')
  console.log('fast_mode                 stable   true')
  process.exit(0)
}
log({ argv, cwd: process.cwd(), env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null, CODEX_HOME: process.env.CODEX_HOME ?? null } })
const mode = process.env.FAKE_MODE || 'ok'
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
let threads = 0
let current = null
const rl = require('readline').createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const m = JSON.parse(line)
  if (!m.method) { log({ clientResponse: m }); return }
  log({ method: m.method, params: m.params })
  const reply = (result) => send({ id: m.id, result })
  switch (m.method) {
    case 'initialize': return reply({})
    case 'initialized': return
    case 'account/read':
      if (mode === 'nologin') return reply({ account: null })
      if (mode === 'apikey') return reply({ account: { type: 'apiKey' } })
      return reply({ account: { type: 'chatgpt', email: 'x@example.com', planType: 'plus' } })
    case 'account/rateLimits/read':
      if (mode === 'nolimits') return send({ id: m.id, error: { code: -32000, message: 'not available' } })
      return reply({ rateLimits: { primary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 2000000000 },
        credits: { hasCredits: mode === 'credits' }, planType: 'plus', rateLimitReachedType: mode === 'limited' ? 'primary' : null } })
    case 'model/list': return reply({ data: [{ id: 'fake-model', isDefault: true }, { id: 'other' }] })
    case 'thread/start': current = 't' + (++threads); return reply({ thread: { id: current }, model: 'fake-model', instructionSources: mode === 'agentsmd' ? [process.env.HOME + '/.codex/AGENTS.md'] : [] })
    case 'thread/unsubscribe': return reply({})
    case 'turn/start': {
      reply({ turn: { id: 'turn1' } })
      const item = (type, extra = {}) => send({ method: 'item/completed', params: { threadId: current, item: { type, id: type + '1', ...extra } } })
      if (mode === 'hang') return
      if (mode === 'exit') process.exit(3)
      if (mode === 'tool') return send({ method: 'item/started', params: { item: { type: 'commandExecution', id: 'c1', command: 'cat secrets' } } })
      if (mode === 'mcp') return send({ method: 'mcpServer/startupStatus/updated', params: { name: 'x', status: 'starting' } })
      if (mode === 'request') return send({ id: 99, method: 'item/commandExecution/requestApproval', params: {} })
      if (mode === 'child') {
        // A grandchild that ignores SIGTERM, as a sandboxed command might.
        const c = require('child_process').spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' })
        log({ childPid: c.pid })
        return
      }
      if (mode === 'twocalls') {
        // A tool call that emits no item: two model requests, then an answer.
        send({ method: 'thread/tokenUsage/updated', params: { threadId: current, tokenUsage: { last: { inputTokens: 40, outputTokens: 5 } } } })
        send({ method: 'thread/tokenUsage/updated', params: { threadId: current, tokenUsage: { last: { inputTokens: 50, outputTokens: 5 } } } })
        item('agentMessage', { text: '{"ok":true}', phase: 'final_answer' })
        return send({ method: 'turn/completed', params: { threadId: current, turn: { id: 'turn1', status: 'completed', items: [] } } })
      }
      if (mode === 'quota') return send({ method: 'turn/completed', params: { turn: { id: 'turn1', status: 'failed', error: { message: 'limit', codexErrorInfo: 'usageLimitExceeded' } } } })
      item('userMessage')
      item('reasoning')
      send({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 13, windowDurationMins: 10080, resetsAt: 2000000000 }, credits: { hasCredits: false }, planType: 'plus' } } })
      item('agentMessage', { text: process.env.FAKE_TEXT || '{"ok":true}', phase: 'final_answer' })
      if (mode === 'late' && threads > 1) send({ method: 'item/completed', params: { threadId: 't' + (threads - 1), item: { type: 'agentMessage', id: 'stale', text: '{"ok":false}', phase: 'final_answer' } } })
      send({ method: 'thread/tokenUsage/updated', params: { threadId: current, tokenUsage: { last: { inputTokens: 40, outputTokens: 5 } } } })
      return send({ method: 'turn/completed', params: { threadId: current, turn: { id: 'turn1', status: 'completed', items: [] } } })
    }
    default: return reply({})
  }
})
`

let dir: string
let script: string
let codexHome: string
let logPath: string

function logLines(): Record<string, unknown>[] {
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>)
}

function spec(over: Partial<RunSpec> = {}): RunSpec {
  return {
    instructions: 'Classify.',
    input: 'Email text',
    output: { type: 'json', schemaName: 's', schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } } },
    model: null, effort: 'low', deadlineAt: Date.now() + 10_000,
    ...over,
  }
}

const runners: CodexRunner[] = []
function runner(opts: { warmMaxAgeMs?: number } = {}): CodexRunner {
  const r = new CodexRunner({ binary: process.execPath, binaryArgs: [script], codexHome, probeTimeoutMs: 5000, ...opts })
  runners.push(r)
  return r
}

afterEach(async () => {
  await Promise.all(runners.splice(0).map(r => r.close()))
})

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'exec-runner-test-'))
  script = join(dir, 'fake-codex.cjs')
  writeFileSync(script, FAKE)
  codexHome = join(dir, 'home')
  mkdirSync(codexHome)
  writeFileSync(join(codexHome, 'config.toml'), 'model = "x"\n[mcp_servers.alpha]\ncommand = "a"\n[mcp_servers."beta.x"]\nurl = "b"\n[mcp_servers.alpha.env]\nK = "v"\n')
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.FAKE_MODE
  delete process.env.FAKE_LOG
})

beforeEach(() => {
  logPath = join(dir, `log-${Math.random().toString(36).slice(2)}.jsonl`)
  process.env.FAKE_LOG = logPath
  process.env.FAKE_MODE = 'ok'
  delete process.env.FAKE_TEXT
})

describe('parsers', () => {
  it('reads enabled features', () => {
    expect([...parseEnabledFeatures('a  stable  true\nb  stable  false\nc under development true\n')]).toEqual(['a', 'c'])
  })

  it('finds MCP server tables, including quoted and nested ones', () => {
    expect(parseMcpServerNames('[mcp_servers.alpha]\n[mcp_servers."be.ta"]\n[mcp_servers.alpha.env]\n[other]\n').sort()).toEqual(['alpha', 'be.ta'])
  })

  it('treats only a ChatGPT plan without credits as subscription billing', () => {
    const rl = parseRateLimits({ rateLimits: { primary: { usedPercent: 1 }, credits: { hasCredits: false } } })
    expect(billingModeFor({ type: 'chatgpt', planType: 'plus' }, rl)).toBe('subscription')
    expect(billingModeFor({ type: 'chatgpt', planType: 'self_serve_business_usage_based' }, rl)).toBe('metered')
    expect(billingModeFor({ type: 'apiKey', planType: null }, rl)).toBe('metered')
    expect(billingModeFor({ type: 'chatgpt', planType: 'plus' }, parseRateLimits({ rateLimits: { credits: { hasCredits: true } } }))).toBe('metered')
    expect(billingModeFor({ type: 'chatgpt', planType: 'plus' }, null)).toBe('unknown')
    expect(billingModeFor(null, rl)).toBe('unknown')
  })

  it('maps quota errors to QUOTA_EXHAUSTED with the reported reset time', () => {
    const rl = parseRateLimits({ rateLimits: { primary: { resetsAt: 2000000000 } } })
    const e = mapTurnError({ message: 'x', codexErrorInfo: 'usageLimitExceeded' }, rl)
    expect(e).toMatchObject({ code: 'QUOTA_EXHAUSTED', retryable: true, retryAfter: new Date(2000000000 * 1000).toISOString() })
    expect(mapTurnError({ message: 'x', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } } }, null).code).toBe('RUNTIME_UNAVAILABLE')
    expect(mapTurnError({ message: 'x', codexErrorInfo: 'unauthorized' }, null).code).toBe('AUTH_REQUIRED')
  })
})

describe('CodexRunner.run', () => {
  it('runs an isolated, ephemeral, schema-constrained turn', async () => {
    process.env.OPENAI_API_KEY = 'sk-should-not-pass'
    const rateLimits: unknown[] = []
    const res = await runner().run(spec(), new AbortController().signal, { onRateLimits: (rl) => rateLimits.push(rl) })
    delete process.env.OPENAI_API_KEY
    expect(res).toMatchObject({ ok: true, text: '{"ok":true}', model: 'fake-model', usage: { inputTokens: 40, outputTokens: 5 }, billingMode: 'subscription' })
    expect(rateLimits.length).toBeGreaterThan(0)

    const lines = logLines()
    const start = lines.find(l => Array.isArray(l.argv) && (l.argv as string[]).includes('app-server'))!
    const argv = start.argv as string[]
    expect(argv).toEqual(expect.arrayContaining(['--disable', 'shell_tool', 'apps', 'web_search="disabled"', 'mcp_servers.alpha.enabled=false', 'mcp_servers."beta.x".enabled=false']))
    expect(argv).toEqual(expect.arrayContaining(['skills.include_instructions=false', 'include_environment_context=false', 'project_doc_max_bytes=0']))
    expect(argv).not.toContain('memories') // already off: not passed
    expect(argv).not.toContain('fast_mode') // not a tool feature
    expect((start.env as Record<string, unknown>).OPENAI_API_KEY).toBeNull()
    expect((start.env as Record<string, unknown>).CODEX_HOME).toBe(codexHome)
    const thread = lines.find(l => l.method === 'thread/start')!.params as Record<string, unknown>
    expect(thread.cwd).not.toBe(start.cwd) // the job's own directory, not the process's
    expect(existsSync(thread.cwd as string)).toBe(false) // removed when the job ended
    expect(thread).toMatchObject({ ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', baseInstructions: 'Classify.', config: { model_reasoning_effort: 'low' } })
    const turn = lines.find(l => l.method === 'turn/start')!.params as Record<string, unknown>
    expect(turn.outputSchema).toEqual(spec().output.type === 'json' ? (spec().output as { schema: unknown }).schema : null)
    expect(turn.input).toEqual([{ type: 'text', text: 'Email text', text_elements: [] }])
  })

  it('omits outputSchema for text jobs', async () => {
    process.env.FAKE_TEXT = 'Tere!'
    const res = await runner().run(spec({ output: { type: 'text' } }), new AbortController().signal)
    expect(res).toMatchObject({ ok: true, text: 'Tere!' })
    const turn = logLines().find(l => l.method === 'turn/start')!.params as Record<string, unknown>
    expect(turn).not.toHaveProperty('outputSchema')
  })

  it.each([
    ['tool', /commandExecution/],
    ['mcp', /MCP server/],
    ['request', /asked the client/],
    ['twocalls', /second model request/],
    ['agentsmd', /instruction files into the job \(AGENTS\.md\)/],
  ])('fails closed when the guard trips (%s)', async (mode, message) => {
    process.env.FAKE_MODE = mode
    const res = await runner().run(spec(), new AbortController().signal)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.code).toBe('UNSUPPORTED_CAPABILITY')
      expect(res.error.message).toMatch(message)
      expect(res.error.retryable).toBe(false)
    }
  })

  it.each([
    ['apikey', 'UNSUPPORTED_CAPABILITY'],
    ['credits', 'UNSUPPORTED_CAPABILITY'],
    ['nologin', 'AUTH_REQUIRED'],
    ['limited', 'QUOTA_EXHAUSTED'],
    ['quota', 'QUOTA_EXHAUSTED'],
    ['exit', 'EXECUTION_INTERRUPTED'],
  ])('refuses or fails without starting a metered or broken turn (%s)', async (mode, code) => {
    process.env.FAKE_MODE = mode
    const res = await runner().run(spec(), new AbortController().signal)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe(code)
    if (mode === 'apikey' || mode === 'credits' || mode === 'nologin' || mode === 'limited') {
      expect(logLines().some(l => l.method === 'turn/start')).toBe(false)
    }
  })

  it('decides billing on a recent usage snapshot only', async () => {
    process.env.FAKE_MODE = 'nolimits'
    const snapshot = (ageMs: number): RateLimitSnapshot => ({
      usedPercent: 1, windowDurationMins: null, resetsAt: null, planType: 'plus', hasCredits: false, limitReached: null,
      at: new Date(Date.now() - ageMs).toISOString(),
    })
    // A recent snapshot is used as is (the warm path): no read, the job runs.
    const warm = runner()
    ;(warm as unknown as { lastRateLimits: RateLimitSnapshot }).lastRateLimits = snapshot(1000)
    expect((await warm.run(spec(), new AbortController().signal)).ok).toBe(true)
    // An old one is not: the read is due, it fails, and billing is unknown.
    const stale = runner()
    ;(stale as unknown as { lastRateLimits: RateLimitSnapshot }).lastRateLimits = snapshot(120_000)
    const res = await stale.run(spec(), new AbortController().signal)
    expect(res).toMatchObject({ ok: false, billingMode: 'unknown', error: { code: 'UNSUPPORTED_CAPABILITY' } })
    expect(logLines().filter(l => l.method === 'turn/start')).toHaveLength(1)
  })

  it.skipIf(process.platform === 'win32')('kills what the app-server started along with it', async () => {
    process.env.FAKE_MODE = 'child'
    const ac = new AbortController()
    const p = runner().run(spec(), ac.signal)
    let pid: number | undefined
    for (let i = 0; i < 50 && !pid; i++) {
      await new Promise(r => setTimeout(r, 50))
      pid = logLines().find(l => typeof l.childPid === 'number')?.childPid as number | undefined
    }
    expect(pid).toBeTypeOf('number')
    ac.abort()
    await p
    let alive = true
    for (let i = 0; i < 20 && alive; i++) {
      try { process.kill(pid!, 0); await new Promise(r => setTimeout(r, 50)) } catch { alive = false }
    }
    expect(alive).toBe(false)
  })

  it('stops at the deadline', async () => {
    process.env.FAKE_MODE = 'hang'
    const res = await runner().run(spec({ deadlineAt: Date.now() + 800 }), new AbortController().signal)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('DEADLINE_EXCEEDED')
  })

  it('cancels a running turn and returns only after the process exited', async () => {
    process.env.FAKE_MODE = 'hang'
    const ac = new AbortController()
    const p = runner().run(spec(), ac.signal)
    setTimeout(() => ac.abort(), 500)
    const res = await p
    expect(res).toMatchObject({ ok: false, canceled: true })
  })
})

describe('CodexRunner.probe', () => {
  it('reports version, account, models and a working inference profile', async () => {
    const p = await runner().probe()
    expect(p).toMatchObject({
      available: true, version: '9.9.9', account: { type: 'chatgpt', planType: 'plus' }, billingMode: 'subscription',
      inferenceProfile: true, error: null,
    })
    expect(p.models.map(m => m.id)).toEqual(['fake-model', 'other'])
  })

  it('does not advertise the profile for metered accounts', async () => {
    process.env.FAKE_MODE = 'apikey'
    const p = await runner().probe()
    expect(p).toMatchObject({ billingMode: 'metered', inferenceProfile: false })
  })

  it('reads rate limits without running a turn', async () => {
    const rl = await runner().readRateLimits()
    expect(rl).toMatchObject({ usedPercent: 12, windowDurationMins: 10080, hasCredits: false })
    expect(logLines().some(l => l.method === 'turn/start')).toBe(false)
  })
})

describe('warm processes', () => {
  const app = () => logLines().filter(l => Array.isArray(l.argv) && (l.argv as string[]).includes('app-server'))
  const threadStarts = () => logLines().filter(l => l.method === 'thread/start').map(l => l.params as Record<string, unknown>)

  it('reuses one process for consecutive jobs, each on its own thread and directory', async () => {
    const r = runner()
    const a = await r.run(spec({ input: 'first email' }), new AbortController().signal)
    const b = await r.run(spec({ input: 'second email' }), new AbortController().signal)
    expect(a.ok && b.ok).toBe(true)
    expect(r.spawnCount).toBe(1)
    expect(app()).toHaveLength(1)
    const [t1, t2] = threadStarts()
    expect(t1.ephemeral && t2.ephemeral).toBe(true)
    expect(t1.cwd).not.toBe(t2.cwd)
    // The finished thread is unloaded before the next job.
    const unsub = logLines().filter(l => l.method === 'thread/unsubscribe').map(l => (l.params as { threadId: string }).threadId)
    expect(unsub).toEqual(['t1', 't2'])
    // The account is read once and cached; usage came from the first turn.
    expect(logLines().filter(l => l.method === 'account/read')).toHaveLength(1)
    expect(r.warmCount).toBe(1)
  })

  it('ignores late notifications from an earlier thread', async () => {
    process.env.FAKE_MODE = 'late'
    const r = runner()
    expect((await r.run(spec(), new AbortController().signal)).ok).toBe(true)
    // The process sends a stale answer for t1 during the t2 job; only t2's answer counts.
    expect(await r.run(spec(), new AbortController().signal)).toMatchObject({ ok: true, text: '{"ok":true}' })
    expect(r.spawnCount).toBe(1)
  })

  it.each([
    ['tool'],
    ['mcp'],
    ['request'],
  ])('replaces the process after a guard trip (%s)', async (mode) => {
    process.env.FAKE_MODE = mode
    const r = runner()
    expect((await r.run(spec(), new AbortController().signal)).ok).toBe(false)
    expect(r.warmCount).toBe(0)
    process.env.FAKE_MODE = 'ok'
    expect((await r.run(spec(), new AbortController().signal)).ok).toBe(true)
    expect(r.spawnCount).toBe(2)
  })

  it('replaces the process after a deadline or a cancel', async () => {
    process.env.FAKE_MODE = 'hang'
    const r = runner()
    expect((await r.run(spec({ deadlineAt: Date.now() + 500 }), new AbortController().signal)).ok).toBe(false)
    expect(r.warmCount).toBe(0)
    const ac = new AbortController()
    setTimeout(() => { ac.abort() }, 300)
    expect(await r.run(spec(), ac.signal)).toMatchObject({ ok: false, canceled: true })
    expect(r.warmCount).toBe(0)
    expect(r.spawnCount).toBe(2)
  })

  it('keeps a process after a failed but completed turn (quota), and not after a crash', async () => {
    process.env.FAKE_MODE = 'quota'
    const r = runner()
    expect((await r.run(spec(), new AbortController().signal)).ok).toBe(false)
    expect(r.warmCount).toBe(1)
    await r.close()
    process.env.FAKE_MODE = 'exit'
    const r2 = runner()
    expect((await r2.run(spec(), new AbortController().signal)).ok).toBe(false)
    expect(r2.warmCount).toBe(0)
  })

  it('retires a process at its maximum age', async () => {
    const r = runner({ warmMaxAgeMs: 400 })
    expect((await r.run(spec(), new AbortController().signal)).ok).toBe(true)
    await new Promise((res) => setTimeout(res, 600))
    expect(r.warmCount).toBe(0)
    expect((await r.run(spec(), new AbortController().signal)).ok).toBe(true)
    expect(r.spawnCount).toBe(2)
  })

  it('starts a new process per job when warm reuse is off', async () => {
    const r = runner({ warmMaxAgeMs: 0 })
    await r.run(spec(), new AbortController().signal)
    await r.run(spec(), new AbortController().signal)
    expect(r.spawnCount).toBe(2)
    expect(r.warmCount).toBe(0)
  })

  it('starts a fresh process when the MCP server list changes', async () => {
    const cfg = join(codexHome, 'config.toml')
    const before = readFileSync(cfg, 'utf-8')
    const r = runner()
    try {
      await r.run(spec(), new AbortController().signal)
      writeFileSync(cfg, before + '[mcp_servers.gamma]\ncommand = "g"\n')
      await r.run(spec(), new AbortController().signal)
      expect(r.spawnCount).toBe(2)
      expect(app()[1].argv).toContain('mcp_servers.gamma.enabled=false')
    } finally {
      writeFileSync(cfg, before)
    }
  })

  it('stops warm processes on close', async () => {
    const r = runner()
    await r.run(spec(), new AbortController().signal)
    expect(r.warmCount).toBe(1)
    await r.close()
    expect(r.warmCount).toBe(0)
    expect((await r.run(spec(), new AbortController().signal)).ok).toBe(false)
  })
})
