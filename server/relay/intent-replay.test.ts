/** Durable replay state must commit before forwarding and survive independent readers. */
import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, statSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { recordPairing } from './machine-trust.js'
import { generateMachineKeyPair } from './machine-identity.js'
import { emptyTrustStore } from './trust-store.js'
import { IntentReplayStore, REPLAY_TTL_MS } from './intent-replay.js'
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'codekin-replay-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

it('deduplicates per user across signers, instances and restarts', () => {
  const file = join(dir, 'replay.sqlite')
  const a = new IntentReplayStore(file, 'm1')
  a.initialize(100, true)
  const b = new IntentReplayStore(file, 'm1')
  expect(a.consume('owner', 'nonce', 100)).toBeNull()
  expect(b.consume('owner', 'nonce', 101)).toBe('intent_replayed')
  expect(new IntentReplayStore(file, 'm1').consume('owner', 'nonce', 102)).toBe('intent_replayed')
  expect(b.consume('other', 'nonce', 103)).toBeNull()
  expect(statSync(file).mode & 0o777).toBe(0o600)
})

it('never evicts a live nonce at capacity and expires only after the boundary', () => {
  const store = new IntentReplayStore(join(dir, 'replay.sqlite'), 'm1', 2)
  store.initialize(100, true)
  expect(store.consume('owner', 'a', 100)).toBeNull()
  expect(store.consume('owner', 'b', 100)).toBeNull()
  expect(store.consume('owner', 'c', 101)).toBe('intent_rate_limited')
  expect(store.consume('owner', 'a', 100 + REPLAY_TTL_MS)).toBe('intent_replayed')
  expect(store.consume('owner', 'c', 101 + REPLAY_TTL_MS)).toBeNull()
})

it('refuses while replay storage cannot be committed or parsed', () => {
  const file = join(dir, 'unavailable')
  mkdirSync(file)
  expect(new IntentReplayStore(file, 'm1').consume('owner', 'n', 100)).toBe('intent_replay_unavailable')
  const corrupt = join(dir, 'corrupt.sqlite')
  writeFileSync(corrupt, 'invalid database')
  expect(new IntentReplayStore(corrupt, 'm1').consume('owner', 'n', 100)).toBe('intent_replay_unavailable')
})

it.each(['missing', 'empty', 'rotated'])('waits out the legacy replay window with a %s audit log and a durable deadline', log => {
  if (log !== 'missing') writeFileSync(join(dir, 'intents.jsonl'), log === 'empty' ? '' : 'old log')
  const file = join(dir, 'replay.sqlite')
  const store = new IntentReplayStore(file, 'm1')
  expect(store.initialize(100)).toBe(true)
  expect(store.consume('owner', 'n', 101)).toBe('intent_replay_unavailable')
  const restarted = new IntentReplayStore(file, 'm1')
  expect(restarted.initialize(200)).toBe(true)
  expect(restarted.consume('owner', 'n', 101 + REPLAY_TTL_MS)).toBeNull()
})


it.each(['same id', 'different id', 'missing', 'unreadable'])('only treats a provably new pairing as fresh (%s prior device list)', previous => {
  const file = join(dir, 'relay-devices.json')
  if (previous !== 'missing') writeFileSync(file, previous === 'unreadable'
    ? 'unreadable' : JSON.stringify(emptyTrustStore(previous === 'same id' ? 'm1' : 'old-machine', 'https://relay.test', 'owner')))
  recordPairing(join(dir, 'relay.json'), 'https://relay.test', 'm1', 'owner', generateMachineKeyPair(), null, { log: () => {}, warn: () => {} })
  const replay = new IntentReplayStore(`${file}.replay.sqlite`, 'm1')
  expect(replay.consume('owner', 'nonce', Date.now())).toBe(previous === 'same id' || previous === 'unreadable' ? 'intent_replay_unavailable' : null)
})
