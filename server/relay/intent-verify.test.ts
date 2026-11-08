/** Tests for signed-intent rules, verification and the local intent log (signed-intents spec §6, §7.2). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash, generateKeyPairSync, randomBytes } from 'crypto'
import type { KeyObject } from 'crypto'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  channelSessionAfter, frameAction, framePayload, frameSession, isExemptFrame, requestAction, requestPayload, requestSession,
} from './intent-actions.js'
import type { IntentBody, SignedIntent } from './intent-actions.js'
import { IntentVerifier, REPLAY_TTL_MS } from './intent-verify.js'
import { GENESIS, IntentLog, lineHash, readRecentIntents, ROTATE_AGE_MS, verifyIntentLog } from './intent-log.js'
import { signP1363 } from './enrolment-crypto.js'
import { keyIdForSpki } from './machine-identity.js'
import { emptyTrustStore, readTrustStore, writeTrustStore } from './trust-store.js'
import type { IntentPolicy } from './trust-store.js'
import type { RelayPrincipal } from './relay-protocol.js'

const OWNER: RelayPrincipal = { userId: 'u-owner', role: 'owner', grants: {} }

describe('intent rules shared with the browser', () => {
  it('names actions and binds sessions the same way for both ends', () => {
    expect(frameAction('{"type":"input","data":"hi"}')).toBe('ws:input')
    expect(frameAction('not json')).toBe('ws:?')
    expect(requestAction('get', '/api/sessions/list?x=1')).toBe('rest:GET /api/sessions/list')
    expect(frameSession('{"type":"join_session","sessionId":"s2"}', 's1')).toBe('s2')
    expect(frameSession('{"type":"input","data":"x"}', 's1')).toBe('s1')
    expect(channelSessionAfter('{"type":"join_session","sessionId":"s2"}', 's1')).toBe('s2')
    expect(channelSessionAfter('{"type":"leave_session"}', 's1')).toBeNull()
    expect(channelSessionAfter('{"type":"input"}', 's1')).toBe('s1')
    expect(requestSession('/api/sessions/abc/rename')).toBe('abc')
    expect(requestSession('/api/sessions/archived/old1')).toBe('old1')
    expect(requestSession('/api/sessions/list')).toBeNull()
    expect(requestSession('/api/sessions/create')).toBeNull()
    expect(requestSession('/api/repos')).toBeNull()
    expect(isExemptFrame('{"type":"ping"}')).toBe(true)
    expect(isExemptFrame('{"type":"resize","cols":1,"rows":1}')).toBe(true)
    expect(isExemptFrame('{"type":"input"}')).toBe(false)
  })

  it('hashes requests over method, path with query, content type and body', () => {
    const bytes = requestPayload('post', '/api/upload?x=1', 'image/png', new Uint8Array([1, 2]))
    expect(Buffer.from(bytes).toString('utf-8', 0, bytes.length - 2)).toBe('POST\n/api/upload?x=1\nimage/png\n')
    expect(Array.from(bytes.slice(-2))).toEqual([1, 2])
    expect(Buffer.from(requestPayload('GET', '/x', undefined, null)).toString()).toBe('GET\n/x\n\n')
  })
})

describe('intent log', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codekin-intent-log-'))
    file = join(dir, 'relay', 'intents.jsonl')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const entry = (action: string) => ({ verdict: 'accepted' as const, forwarded: true, action, sessionId: null, userId: 'u', keyId: 'k', payloadHash: 'h' })

  it('chains every line to the one before, mode 0600, and picks up where it left off', () => {
    const log = new IntentLog(file)
    expect(log.append(entry('ws:input'))).toMatchObject({ seq: 1, prev: GENESIS })
    log.append(entry('ws:stop'))
    expect(statSync(file).mode & 0o777).toBe(0o600)
    // A new process continues the same chain.
    const again = new IntentLog(file)
    const third = again.append(entry('ws:input'))
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(third).toMatchObject({ seq: 3, prev: lineHash(lines[1]) })
    expect(verifyIntentLog(file)).toEqual({ ok: true, entries: 3 })
  })

  it('detects an edited, removed or torn line', () => {
    const log = new IntentLog(file)
    for (const a of ['a', 'b', 'c']) log.append(entry(a))
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    writeFileSync(file, [lines[0], lines[1].replace('"b"', '"x"'), lines[2]].join('\n') + '\n')
    expect(verifyIntentLog(file)).toMatchObject({ ok: false, problem: { line: 3 } })
    writeFileSync(file, [lines[0], lines[2]].join('\n') + '\n')
    expect(verifyIntentLog(file)).toMatchObject({ ok: false, problem: { line: 2 } })
    writeFileSync(file, lines.join('\n') + '\n')
    appendFileSync(file, '{"seq":4,"pre')
    expect(verifyIntentLog(file)).toMatchObject({ ok: false, problem: { line: 4, reason: expect.stringContaining('torn') } })
  })

  it('rotates after 30 days and keeps the chain across files', () => {
    let now = Date.parse('2026-11-08T00:00:00Z')
    const log = new IntentLog(file, () => now)
    log.append(entry('a'))
    const last = readFileSync(file, 'utf8').trim()
    now += ROTATE_AGE_MS + 1
    expect(log.append(entry('b'))).toMatchObject({ seq: 2, prev: lineHash(last) })
    expect(readdirSync(join(dir, 'relay')).filter(f => f.startsWith('intents-'))).toHaveLength(1)
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1)
  })

  it('lists newest first with filters', () => {
    const log = new IntentLog(file)
    log.append(entry('a'))
    log.append({ ...entry('b'), verdict: 'rejected', reason: 'intent_bad_signature', keyId: 'k2', sessionId: 's1' })
    log.append(entry('c'))
    expect(readRecentIntents(file).map(e => e.action)).toEqual(['c', 'b', 'a'])
    expect(readRecentIntents(file, { verdict: 'rejected' }).map(e => e.action)).toEqual(['b'])
    expect(readRecentIntents(file, { keyId: 'k2', sessionId: 's1' })).toHaveLength(1)
    expect(readRecentIntents(file, { limit: 1 }).map(e => e.action)).toEqual(['c'])
  })

  it('never throws when it cannot write', () => {
    const warn = vi.fn()
    writeFileSync(join(dir, 'relay'), 'a file where the directory should be')
    expect(new IntentLog(file, Date.now, { warn }).append(entry('a'))).toBeNull()
    expect(warn).toHaveBeenCalled()
  })
})

describe('IntentVerifier', () => {
  let dir: string
  let devicesFile: string
  let logFile: string
  let now: number
  let key: { spki: string; keyId: string; privateKey: KeyObject }
  let verifier: IntentVerifier

  function writeStore(policy: IntentPolicy, extra: { credentials?: boolean; ownerUserId?: string | null } = {}) {
    writeTrustStore(devicesFile, {
      ...emptyTrustStore('m1', 'https://relay.test', extra.ownerUserId === undefined ? 'u-owner' : extra.ownerUserId),
      policy,
      credentials: extra.credentials === false ? [] : [{
        keyId: key.keyId, kind: 'browser', userId: 'u-owner', spki: key.spki, label: 'Firefox', addedAt: '2026-11-08T00:00:00Z', addedBy: 'local',
      }],
    })
  }

  function sign(fields: Partial<IntentBody> & { action: string; payload: Uint8Array; sessionId?: string | null }, signer = key.privateKey): SignedIntent {
    const { payload, ...rest } = fields
    const body: IntentBody = {
      v: 1, machineId: 'm1', sessionId: null, nonce: randomBytes(16).toString('base64url'), ts: now, keyId: key.keyId,
      payloadHash: createHash('sha256').update(payload).digest('base64url'),
      ...rest,
    }
    const text = JSON.stringify(body)
    return { body: text, sig: signP1363(signer, Buffer.from(text)).toString('base64url') }
  }

  const req = (intent?: SignedIntent, path = '/api/sessions/list') => ({ method: 'GET', path, principal: OWNER, ...(intent ? { intent } : {}) })
  const signedReq = (path = '/api/sessions/list', extra: Partial<IntentBody> = {}) =>
    req(sign({ action: requestAction('GET', path), sessionId: requestSession(path), payload: requestPayload('GET', path, undefined, null), ...extra }), path)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codekin-verify-'))
    devicesFile = join(dir, 'relay-devices.json')
    logFile = join(dir, 'intents.jsonl')
    now = Date.parse('2026-11-08T12:00:00Z')
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const spki = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
    key = { spki, keyId: keyIdForSpki(spki), privateKey: pair.privateKey }
    writeStore('required')
    verifier = new IntentVerifier({ machineId: 'm1', devicesFile, log: new IntentLog(logFile, () => now), now: () => now })
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const logged = () => readRecentIntents(logFile, { limit: 1000 }).reverse()

  it('accepts a signed request from the recorded owner and logs it with the intent', () => {
    expect(verifier.checkRequest(signedReq())).toMatchObject({ forward: true, verdict: 'accepted' })
    const [line] = logged()
    expect(line).toMatchObject({ verdict: 'accepted', action: 'rest:GET /api/sessions/list', userId: 'u-owner', keyId: key.keyId, forwarded: true })
    expect(line.intent?.sig).toBeDefined()
  })

  it('refuses each way an intent can be wrong, with the reason', () => {
    const cases: Array<[string, () => ReturnType<IntentVerifier['checkRequest']>]> = [
      ['intent_required', () => verifier.checkRequest(req())],
      ['intent_malformed', () => verifier.checkRequest(req({ body: '{"v":1' }))],
      ['intent_wrong_machine', () => verifier.checkRequest(signedReq('/api/sessions/list', { machineId: 'm2' }))],
      ['intent_wrong_action', () => verifier.checkRequest({ ...signedReq('/api/sessions/list'), method: 'DELETE' })],
      ['intent_wrong_payload', () => verifier.checkRequest({ ...signedReq('/api/repos'), path: '/api/repos?all=1' })],
      ['intent_wrong_session', () => verifier.checkRequest(signedReq('/api/sessions/s1/rename', { sessionId: 's2' }))],
      ['intent_stale', () => verifier.checkRequest(signedReq('/api/sessions/list', { ts: now - 6 * 60_000 }))],
      ['intent_unknown_key', () => verifier.checkRequest(signedReq('/api/sessions/list', { keyId: 'nope' }))],
      ['intent_wrong_signer', () => verifier.checkRequest({ ...signedReq(), principal: { userId: 'u-other', role: 'owner', grants: {} } })],
      ['intent_wrong_signer', () => verifier.checkRequest({ ...signedReq(), principal: { userId: 'u-owner', role: 'grantee', grants: {} } })],
      ['intent_bad_signature', () => {
        const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey
        return verifier.checkRequest(req(sign({ action: 'rest:GET /api/sessions/list', payload: requestPayload('GET', '/api/sessions/list', undefined, null) }, other)))
      }],
      ['intent_unsupported', () => verifier.checkRequest(req({ body: signedReq().intent!.body, webauthn: { authenticatorData: 'a', clientDataJSON: 'b', signature: 'c' } }))],
    ]
    for (const [reason, run] of cases) {
      expect(run(), reason).toMatchObject({ forward: false, reason })
    }
    expect(logged().map(e => e.reason)).toEqual(cases.map(([r]) => r))
    expect(logged().every(e => !e.forwarded)).toBe(true)
  })

  it('refuses a replay of the same intent, and forgets nonces after the window', () => {
    const r = signedReq()
    expect(verifier.checkRequest(r).forward).toBe(true)
    expect(verifier.checkRequest(r)).toMatchObject({ forward: false, reason: 'intent_replayed' })
    now += REPLAY_TTL_MS + 1
    // By then the timestamp is stale anyway.
    expect(verifier.checkRequest(r).reason).toBe('intent_stale')
  })

  it('tells the browser the machine time on a stale intent', () => {
    expect(verifier.checkRequest(signedReq('/api/sessions/list', { ts: now + 10 * 60_000 }))).toMatchObject({ reason: 'intent_stale', machineTime: now })
  })

  it('binds frames to the channel session, with join_session naming its own', () => {
    const frame = (data: string, sessionId: string | null) => sign({ action: frameAction(data), sessionId, payload: framePayload(data) })
    const input = '{"type":"input","data":"ls"}'
    expect(verifier.checkFrame(OWNER, input, frame(input, 's1'), 's1').forward).toBe(true)
    // The relay can't move a signed input to another session.
    expect(verifier.checkFrame(OWNER, input, frame(input, 's1'), 's2')).toMatchObject({ forward: false, reason: 'intent_wrong_session' })
    const join = '{"type":"join_session","sessionId":"s9"}'
    expect(verifier.checkFrame(OWNER, join, frame(join, 's9'), 's1').forward).toBe(true)
    // ping/resize carry nothing and need no intent, even when required.
    expect(verifier.checkFrame(OWNER, '{"type":"ping"}', undefined, null)).toEqual({ forward: true, verdict: 'exempt' })
    expect(verifier.checkChannelOpen(OWNER, sign({ action: 'channel:open', payload: new Uint8Array() })).forward).toBe(true)
    expect(verifier.checkChannelOpen(OWNER, undefined)).toMatchObject({ forward: false, reason: 'intent_required' })
  })

  it('lets webhook deliveries through: GitHub signs those', () => {
    expect(verifier.checkRequest({ method: 'POST', path: '/api/webhooks/github', principal: { userId: 'u-owner', role: 'webhook', grants: {} } }))
      .toEqual({ forward: true, verdict: 'exempt' })
  })

  it('in warn mode forwards everything and logs unsigned and bad intents', () => {
    writeStore('warn')
    expect(verifier.checkRequest(req())).toMatchObject({ forward: true, verdict: 'unsigned', reason: 'intent_required' })
    expect(verifier.checkRequest(signedReq('/api/sessions/list', { machineId: 'm2' }))).toMatchObject({ forward: true, verdict: 'rejected' })
    expect(logged().map(e => [e.verdict, e.forwarded])).toEqual([['unsigned', true], ['rejected', true]])
  })

  it('in off mode forwards everything, logs what is signed, and stays quiet about unsigned', () => {
    writeStore('off')
    expect(verifier.checkRequest(req())).toEqual({ forward: true, verdict: 'unsigned' })
    expect(verifier.checkRequest(signedReq()).verdict).toBe('accepted')
    expect(logged().map(e => e.verdict)).toEqual(['accepted'])
  })

  it('keeps the last known policy when the device list becomes unreadable', () => {
    expect(verifier.policy()).toBe('required')
    writeFileSync(devicesFile, '{ broken')
    expect(verifier.policy()).toBe('required')
    expect(verifier.checkRequest(req()).forward).toBe(false)
  })

  it('records when a device was last used, at most every ten minutes', () => {
    verifier.checkRequest(signedReq())
    expect(readTrustStore(devicesFile)?.credentials[0].lastUsedAt).toBe(new Date(now).toISOString())
    now += 60_000
    verifier.checkRequest(signedReq())
    expect(readTrustStore(devicesFile)?.credentials[0].lastUsedAt).toBe(new Date(now - 60_000).toISOString())
    expect(existsSync(devicesFile)).toBe(true)
  })
})
