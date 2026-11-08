// @vitest-environment node
/** Independent adapters model separate browser tabs using the same IndexedDB. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { getOrCreateBrowserKey, indexedDbTrustStorage } from './deviceTrust'

beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()) })
afterEach(() => { vi.unstubAllGlobals() })

it('concurrent first-use tabs all return the single committed, non-extractable key', async () => {
  const tabs = Array.from({ length: 8 }, () => indexedDbTrustStorage())
  const keys = await Promise.all(tabs.map(storage => getOrCreateBrowserKey('owner', storage)))
  expect(new Set(keys.map(k => k.keyId)).size).toBe(1)
  expect(new Set(keys.map(k => k.spki)).size).toBe(1)
  for (const key of keys) expect(key.keyPair.privateKey.extractable).toBe(false)
  expect((await tabs[0].getKey('owner'))?.keyId).toBe(keys[0].keyId)
  // The returned keys can actually sign for the public key that was pinned.
  const payload = new TextEncoder().encode('confirmed device')
  const publicKey = await crypto.subtle.importKey('spki', Buffer.from(keys[0].spki, 'base64url'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  for (const key of keys) {
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.keyPair.privateKey, payload)
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, sig, payload)).toBe(true)
  }
})

it('independent tabs retain every concurrent revocation and issued-share update', async () => {
  const tabs = [indexedDbTrustStorage(), indexedDbTrustStorage()]
  await Promise.all(Array.from({ length: 12 }, (_, i) => tabs[i % 2].updateRevocations!('u', 'm', list => [...list, { grantId: `g${i}` }])))
  expect((await tabs[0].getRevocations!('u', 'm')).map(r => r.grantId).sort()).toEqual(Array.from({ length: 12 }, (_, i) => `g${i}`).sort())
  await Promise.all(Array.from({ length: 12 }, (_, i) => tabs[i % 2].updateIssuedGrants!('u', 'm', list => [...list, {
    shareId: `s${i}`, sessionId: 's', granteeUserId: 'd', role: 'viewer', notAfter: null, current: null, issuedIds: [], revoked: false,
  }])))
  expect((await tabs[1].getIssuedGrants!('u', 'm')).length).toBe(12)
})
