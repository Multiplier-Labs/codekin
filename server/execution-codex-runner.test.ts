import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  CodexRunner, parseEnabledFeatures, parseMcpServerNames, billingModeFor, mapTurnError, parseRateLimits, type RunSpec,
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
      return reply({ rateLimits: { primary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 2000000000 },
        credits: { hasCredits: mode === 'credits' }, planType: 'plus', rateLimitReachedType: mode === 'limited' ? 'primary' : null } })
    case 'model/list': return reply({ data: [{ id: 'fake-model', isDefault: true }, { id: 'other' }] })
    case 'thread/start': return reply({ thread: { id: 't1' }, model: 'fake-model' })
    case 'turn/start': {
      reply({ turn: { id: 'turn1' } })
      const item = (type, extra = {}) => send({ method: 'item/completed', params: { item: { type, id: type + '1', ...extra } } })
      if (mode === 'hang') return
      if (mode === 'exit') process.exit(3)
      if (mode === 'tool') return send({ method: 'item/started', params: { item: { type: 'commandExecution', id: 'c1', command: 'cat secrets' } } })
      if (mode === 'mcp') return send({ method: 'mcpServer/startupStatus/updated', params: { name: 'x', status: 'starting' } })
      if (mode === 'request') return send({ id: 99, method: 'item/commandExecution/requestApproval', params: {} })
      if (mode === 'quota') return send({ method: 'turn/completed', params: { turn: { id: 'turn1', status: 'failed', error: { message: 'limit', codexErrorInfo: 'usageLimitExceeded' } } } })
      item('userMessage')
      item('reasoning')
      send({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 13, windowDurationMins: 10080, resetsAt: 2000000000 }, credits: { hasCredits: false }, planType: 'plus' } } })
      item('agentMessage', { text: process.env.FAKE_TEXT || '{"ok":true}', phase: 'final_answer' })
      send({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { last: { inputTokens: 40, outputTokens: 5 } } } })
      return send({ method: 'turn/completed', params: { turn: { id: 'turn1', status: 'completed', items: [] } } })
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

function runner(): CodexRunner {
  return new CodexRunner({ binary: process.execPath, binaryArgs: [script], codexHome, probeTimeoutMs: 5000 })
}

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
    expect(argv).not.toContain('memories') // already off: not passed
    expect(argv).not.toContain('fast_mode') // not a tool feature
    expect((start.env as Record<string, unknown>).OPENAI_API_KEY).toBeNull()
    expect((start.env as Record<string, unknown>).CODEX_HOME).toBe(codexHome)
    expect(existsSync(start.cwd as string)).toBe(false) // temp dir removed

    const thread = lines.find(l => l.method === 'thread/start')!.params as Record<string, unknown>
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
