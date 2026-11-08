/** Tests for signed-intent rules, verification and the local intent log (signed-intents spec §6, §7.2). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash, generateKeyPairSync, randomBytes } from 'crypto'
import type { KeyObject } from 'crypto'
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  MACHINE_TIME_LABEL, channelSessionAfter, frameAction, framePayload, frameSession, isExemptFrame, requestAction, requestPayload, requestSession,
} from './intent-actions.js'
import type { IntentBody, SignedIntent } from './intent-actions.js'
import { IntentVerifier, REPLAY_TTL_MS } from './intent-verify.js'
import { GENESIS, IntentLog, KEEP_ROTATED, lineHash, readRecentIntents, REFUSALS_PER_MINUTE, ROTATE_AGE_MS, verifyIntentLog } from './intent-log.js'
import { signP1363, transcript, verifyP1363 } from './enrolment-crypto.js'
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
    // create_session moves the socket to a session neither end knows yet.
    expect(channelSessionAfter('{"type":"create_session","name":"n","workingDir":"/x"}', 's1', 7)).toBe('@created:7')
    expect(requestSession('/api/sessions/abc/rename')).toBe('abc')
    expect(requestSession('/api/sessions/archived/old1')).toBe('old1')
    expect(requestSession('/api/sessions/list')).toBeNull()
    expect(requestSession('/api/sessions/create')).toBeNull()
    expect(requestSession('/api/repos')).toBeNull()
    expect(isExemptFrame('{"type":"ping"}')).toBe(true)
    expect(isExemptFrame('{"type":"resize","cols":1,"rows":1}')).toBe(true)
    expect(isExemptFrame('{"type":"input"}')).toBe(false)
  })

  it('hashes requests over length-prefixed method, path with query, content type and body', () => {
    const bytes = Buffer.from(requestPayload('post', '/api/upload?x=1', 'image/png', new Uint8Array([1, 2])))
    expect(bytes.readUInt32BE(0)).toBe(4)
    expect(bytes.toString('utf-8', 4, 8)).toBe('POST')
    expect(Array.from(bytes.subarray(-2))).toEqual([1, 2])
    // A newline in the content type can't shift bytes between fields.
    const a = Buffer.from(requestPayload('POST', '/x', 'a\nb', new Uint8Array([1])))
    const b = Buffer.from(requestPayload('POST', '/x', 'a', new TextEncoder().encode('b\n\u0001')))
    expect(a.equals(b)).toBe(false)
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

  it('rate-limits refusal lines so a relay cannot fill the disk, and says how many it dropped', () => {
    const now = Date.parse('2026-11-08T12:00:00Z')
    const log = new IntentLog(file, () => now)
    for (let i = 0; i < REFUSALS_PER_MINUTE + 50; i++) log.append({ ...entry('ws:input'), verdict: 'rejected', reason: 'intent_bad_signature' })
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(REFUSALS_PER_MINUTE)
    // Accepted entries always go in, and carry the count of what was left out.
    expect(log.append(entry('ws:stop'))).toMatchObject({ suppressedBefore: 50 })
  })

  it('keeps a bounded number of rotated files', () => {
    let now = Date.parse('2026-01-01T00:00:00Z')
    const log = new IntentLog(file, () => now)
    for (let i = 0; i < KEEP_ROTATED + 3; i++) {
      log.append(entry('a'))
      now += ROTATE_AGE_MS + 1
    }
    log.append(entry('a'))
    expect(readdirSync(join(dir, 'relay')).filter(f => f.startsWith('intents-'))).toHaveLength(KEEP_ROTATED)
  })

  it('starts a new line after a torn one, and keeps counting', () => {
    const log = new IntentLog(file)
    log.append(entry('a'))
    appendFileSync(file, '{"seq":2,"pre')
    const next = new IntentLog(file).append(entry('b'))
    expect(next?.seq).toBe(2)
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[2])).toMatchObject({ action: 'b' })
    expect(verifyIntentLog(file)).toMatchObject({ ok: false, problem: { line: 2 } })
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

  it('tells the browser the machine time on a stale intent, signed with the machine key', () => {
    expect(verifier.checkRequest(signedReq('/api/sessions/list', { ts: now + 10 * 60_000 }))).toMatchObject({ reason: 'intent_stale', machineTime: now })
    expect(verifier.checkRequest(signedReq('/api/sessions/list', { ts: now + 10 * 60_000 })).machineTimeSig).toBeUndefined()
    const machine = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const signing = new IntentVerifier({
      machineId: 'm1', devicesFile, now: () => now,
      signWithMachineKey: data => signP1363(machine.privateKey, data).toString('base64url'),
    })
    const decision = signing.checkRequest(signedReq('/api/sessions/list', { ts: now - 10 * 60_000 }))
    const spki = machine.publicKey.export({ format: 'der', type: 'spki' })
    expect(verifyP1363(spki, transcript(MACHINE_TIME_LABEL, decision.nonce!, String(now)), Buffer.from(decision.machineTimeSig!, 'base64url'))).toBe(true)
  })

  it('retries reading a device list after a failed read, even when the file did not change', () => {
    writeStore('warn')
    const fresh = new IntentVerifier({ machineId: 'm1', devicesFile, now: () => now })
    // Unreadable for a moment (same size, mtime and inode afterwards).
    chmodSync(devicesFile, 0o000)
    expect(fresh.policy()).toBe('required')
    chmodSync(devicesFile, 0o600)
    expect(fresh.policy()).toBe('warn')
  })

  /** Open a channel with a signed open; returns the verifier's channel state and a frame signer for it. */
  function openChannel(token = randomBytes(16).toString('base64url')) {
    const opened = verifier.checkChannelOpen(OWNER, sign({ action: 'channel:open', payload: new Uint8Array(), channel: token }))
    let seq = 0
    const frame = (data: string, sessionId: string | null, over: Partial<IntentBody> = {}) =>
      sign({ action: frameAction(data), sessionId, payload: framePayload(data), channel: token, seq: ++seq, ...over })
    return { opened, channel: opened.channel, frame, token }
  }

  it('binds frames to the channel session, with join_session naming its own', () => {
    const { opened, channel, frame } = openChannel()
    expect(opened.decision.forward).toBe(true)
    expect(channel.token).not.toBeNull()
    const join = '{"type":"join_session","sessionId":"s1"}'
    expect(verifier.checkFrame(OWNER, join, frame(join, 's1'), channel).forward).toBe(true)
    expect(channel.session).toBe('s1')
    const input = '{"type":"input","data":"ls"}'
    expect(verifier.checkFrame(OWNER, input, frame(input, 's1'), channel).forward).toBe(true)
    // The relay can't move a signed input to another session.
    expect(verifier.checkFrame(OWNER, input, frame(input, 's2'), channel)).toMatchObject({ forward: false, reason: 'intent_wrong_session' })
    // ping/resize carry nothing and need no intent, even when required.
    expect(verifier.checkFrame(OWNER, '{"type":"ping"}', undefined, channel)).toEqual({ forward: true, verdict: 'exempt' })
    expect(verifier.checkChannelOpen(OWNER, undefined).decision).toMatchObject({ forward: false, reason: 'intent_required' })
    // An open without a well-formed token is refused.
    expect(verifier.checkChannelOpen(OWNER, sign({ action: 'channel:open', payload: new Uint8Array() })).decision.reason).toBe('intent_wrong_channel')
  })

  it('refuses frames out of order or moved to another channel', () => {
    const a = openChannel()
    const b = openChannel()
    const first = '{"type":"set_permission_mode","permissionMode":"default"}'
    const second = '{"type":"input","data":"deploy"}'
    const i1 = a.frame(first, null)
    const i2 = a.frame(second, null)
    // The relay delivers the second first: then the first is out of order.
    expect(verifier.checkFrame(OWNER, second, i2, a.channel).forward).toBe(true)
    expect(verifier.checkFrame(OWNER, first, i1, a.channel)).toMatchObject({ forward: false, reason: 'intent_out_of_order' })
    // A frame signed for channel a can't be played on channel b.
    const i3 = a.frame(second, null)
    expect(verifier.checkFrame(OWNER, second, i3, b.channel)).toMatchObject({ forward: false, reason: 'intent_wrong_channel' })
    // Dropped frames leave gaps, which are fine.
    const i5 = a.frame(second, null, { seq: 99 })
    expect(verifier.checkFrame(OWNER, second, i5, a.channel).forward).toBe(true)
  })

  it('binds frames after create_session to the created session, not the old one', () => {
    const { channel, frame } = openChannel()
    const join = '{"type":"join_session","sessionId":"A"}'
    verifier.checkFrame(OWNER, join, frame(join, 'A'), channel)
    const create = '{"type":"create_session","name":"n","workingDir":"/w"}'
    expect(verifier.checkFrame(OWNER, create, frame(create, 'A'), channel).forward).toBe(true)
    expect(channel.session).toBe('@created:2')
    const input = '{"type":"input","data":"y"}'
    // Signed for the old session: refused, since the socket is now in the new one.
    expect(verifier.checkFrame(OWNER, input, frame(input, 'A'), channel).reason).toBe('intent_wrong_session')
    expect(verifier.checkFrame(OWNER, input, frame(input, '@created:2'), channel).forward).toBe(true)
  })

  it('remembers accepted nonces across a restart, from the log', () => {
    const r = signedReq()
    expect(verifier.checkRequest(r).forward).toBe(true)
    const restarted = new IntentVerifier({ machineId: 'm1', devicesFile, log: new IntentLog(logFile, () => now), now: () => now })
    expect(restarted.checkRequest(r)).toMatchObject({ forward: false, reason: 'intent_replayed' })
  })

  it('refuses rather than forgets when the replay cache is full', async () => {
    const mod = await import('./intent-verify.js')
    const cache = (verifier as unknown as { replay: Map<string, number> }).replay
    for (let i = 0; i < mod.REPLAY_CACHE_MAX; i++) cache.set(`k:${i}`, now + REPLAY_TTL_MS)
    expect(verifier.checkRequest(signedReq())).toMatchObject({ forward: false, reason: 'intent_rate_limited' })
  })

  it('counts a nonce as used up to the end of its window', () => {
    const r = signedReq()
    verifier.checkRequest(r)
    now += REPLAY_TTL_MS
    // Exactly at the edge the entry still counts (and the timestamp is long stale).
    expect(verifier.checkRequest(r).reason).toBe('intent_stale')
    expect((verifier as unknown as { replay: Map<string, number> }).replay.size).toBe(1)
  })

  it('fails closed on a device list that exists but cannot be read', () => {
    writeStore('off')
    const fresh = new IntentVerifier({ machineId: 'm1', devicesFile, now: () => now })
    writeFileSync(devicesFile, '{ broken')
    expect(fresh.policy()).toBe('required')
    expect(fresh.checkRequest(req()).forward).toBe(false)
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

  it('records when a device was last used, at most every ten minutes, off the request path', async () => {
    verifier.checkRequest(signedReq())
    expect(readTrustStore(devicesFile)?.credentials[0].lastUsedAt).toBeUndefined()
    await new Promise(r => setImmediate(r))
    expect(readTrustStore(devicesFile)?.credentials[0].lastUsedAt).toBe(new Date(now).toISOString())
    now += 60_000
    verifier.checkRequest(signedReq())
    await new Promise(r => setImmediate(r))
    expect(readTrustStore(devicesFile)?.credentials[0].lastUsedAt).toBe(new Date(now - 60_000).toISOString())
    expect(existsSync(devicesFile)).toBe(true)
  })

  it('keeps only accepted intents in the log', () => {
    verifier.checkRequest(signedReq())
    verifier.checkRequest(signedReq('/api/sessions/list', { machineId: 'm2' }))
    const [accepted, rejected] = logged()
    expect(accepted.intent).toBeDefined()
    expect(rejected.intent).toBeUndefined()
  })
})
