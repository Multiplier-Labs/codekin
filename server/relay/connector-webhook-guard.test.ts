/**
 * The webhook replay guard fails closed: history it can't read or write
 * refuses deliveries, lost history refuses what it can no longer check, and
 * every connector on the machine shares one history.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { WebhookReplayGuard, WEBHOOK_RETENTION_MS, WEBHOOK_RECOVERY_SLACK_MS } from './connector-webhook-guard.js'

let dir: string
let now: number
const clock = () => now
const H = { 'x-github-delivery': 'd-1' }
const dated = (at: number, n = 1) => Buffer.from(JSON.stringify({ n, workflow_run: { updated_at: new Date(at).toISOString() } }))

/** Claim and accept, as the connector does for a 2xx. */
function accept(guard: WebhookReplayGuard, body: Buffer): void {
  const verdict = guard.check(H, body)
  expect(verdict.ok).toBe(true)
  if (verdict.ok) guard.record(verdict.deliveryId)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ck-webhook-guard-'))
  now = Date.parse('2026-11-09T12:00:00Z')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('webhook replay guard', () => {
  it('refuses a replay after its history file is corrupted, and accepts new events', () => {
    const file = join(dir, 'd.sqlite')
    const old = dated(now - 60_000)
    accept(new WebhookReplayGuard(file, clock), old)
    writeFileSync(file, 'not a database')
    now += 60 * 60_000
    const restarted = new WebhookReplayGuard(file, clock)
    expect(restarted.check(H, old)).toMatchObject({ ok: false, reason: expect.stringContaining('replay history') })
    expect(restarted.check(H, dated(now - 1000, 2)).ok).toBe(true)
    expect(readdirSync(dir).some(f => f.startsWith('d.sqlite.corrupt-'))).toBe(true)
  })

  it('refuses every delivery when its history cannot be stored', () => {
    writeFileSync(join(dir, 'blocker'), '')
    const guard = new WebhookReplayGuard(join(dir, 'blocker', 'd.sqlite'), clock)
    expect(guard.check(H, dated(now))).toMatchObject({ ok: false, reason: expect.stringContaining('unavailable') })
  })

  it('is shared by two connectors on one machine, from the moment one claims a delivery', () => {
    const file = join(dir, 'd.sqlite')
    const cli = new WebhookReplayGuard(file, clock)
    const embedded = new WebhookReplayGuard(file, clock)
    const body = dated(now)
    const claimed = cli.check(H, body)
    expect(claimed.ok).toBe(true)
    expect(embedded.check(H, body).ok).toBe(false)
    if (claimed.ok) cli.record(claimed.deliveryId)
    expect(embedded.check({ 'x-github-delivery': 'fresh-id' }, body).ok).toBe(false)
  })

  it('lets a genuine delivery through after a refused one is released', () => {
    const guard = new WebhookReplayGuard(null, clock)
    const body = dated(now)
    const forged = guard.check(H, body)
    expect(forged.ok).toBe(true)
    if (forged.ok) guard.release(forged.deliveryId)
    accept(guard, body)
    expect(guard.check(H, body).ok).toBe(false)
  })

  it('never forgets a dated delivery inside the window, however many undated ones follow', () => {
    const guard = new WebhookReplayGuard(null, clock)
    const run = dated(now)
    accept(guard, run)
    for (let i = 0; i < 20_100; i++) accept(guard, Buffer.from(`{"ref":"refs/heads/b${i}"}`))
    expect(guard.check(H, run).ok).toBe(false)
   }, 30_000)

  it('keeps an event dated ahead of the machine clock until the window passes for the event too', () => {
    const guard = new WebhookReplayGuard(null, clock)
    const ahead = dated(now + 60 * 60_000)
    accept(guard, ahead)
    now += WEBHOOK_RETENTION_MS + 60_000
    expect(guard.check(H, ahead).ok).toBe(false)
  })

  it('starts a new history in recovery: only events dated after it began are accepted', () => {
    const guard = new WebhookReplayGuard(join(dir, 'd.sqlite'), clock)
    expect(guard.check(H, dated(now - WEBHOOK_RECOVERY_SLACK_MS - 1000)).ok).toBe(false)
    expect(guard.check(H, dated(now - 1000, 2)).ok).toBe(true)
  })

  it('imports the JSON history once and sets it aside', () => {
    const body = Buffer.from('{"ref":"refs/heads/main"}')
    const key = `u:${createHash('sha256').update(body).digest('hex')}`
    writeFileSync(join(dir, 'd.json'), JSON.stringify({ deliveries: { [key]: now - 1000 } }))
    const guard = new WebhookReplayGuard(join(dir, 'd.sqlite'), clock)
    expect(guard.check(H, body).ok).toBe(false)
    expect(existsSync(join(dir, 'd.json'))).toBe(false)
    expect(existsSync(join(dir, 'd.json.migrated'))).toBe(true)
  })
})
