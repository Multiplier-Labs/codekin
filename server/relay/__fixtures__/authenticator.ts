/**
 * A software passkey for tests: makes COSE public keys and get() assertions
 * the way a platform authenticator would.
 */

import { createHash, generateKeyPairSync, sign } from 'crypto'
import type { KeyObject } from 'crypto'

/** Minimal CBOR encoder for COSE keys (ints, byte strings, maps). */
function cbor(value: number | Uint8Array | Map<number, number | Uint8Array>): Buffer {
  const head = (major: number, n: number): Buffer => {
    if (n < 24) return Buffer.from([(major << 5) | n])
    if (n < 256) return Buffer.from([(major << 5) | 24, n])
    if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255])
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b
  }
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value)
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Buffer.from(value)])
  const parts = [head(5, value.size)]
  for (const [k, v] of value) parts.push(cbor(k), cbor(v))
  return Buffer.concat(parts)
}

export type Alg = 'ES256' | 'RS256' | 'EdDSA'

export interface SoftPasskey {
  credentialId: string
  /** base64url COSE_Key */
  cosePublicKey: string
  privateKey: KeyObject
  alg: Alg
  /** Make an assertion over `challenge` for `origin`/`rpId`. */
  assert(challenge: Uint8Array, opts?: { origin?: string; rpId?: string; flags?: number; type?: string }): {
    authenticatorData: string
    clientDataJSON: string
    signature: string
  }
}

export function softPasskey(alg: Alg = 'ES256', defaults = { origin: 'https://relay.test', rpId: 'relay.test' }): SoftPasskey {
  let cose: Map<number, number | Uint8Array>
  let privateKey: KeyObject
  if (alg === 'ES256') {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const jwk = pair.publicKey.export({ format: 'jwk' })
    cose = new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]])
    privateKey = pair.privateKey
  } else if (alg === 'RS256') {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const jwk = pair.publicKey.export({ format: 'jwk' })
    cose = new Map<number, number | Uint8Array>([[1, 3], [3, -257], [-1, Buffer.from(jwk.n!, 'base64url')], [-2, Buffer.from(jwk.e!, 'base64url')]])
    privateKey = pair.privateKey
  } else {
    const pair = generateKeyPairSync('ed25519')
    const jwk = pair.publicKey.export({ format: 'jwk' })
    cose = new Map<number, number | Uint8Array>([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(jwk.x!, 'base64url')]])
    privateKey = pair.privateKey
  }
  const credentialId = Buffer.from(createHash('sha256').update(cbor(cose)).digest()).subarray(0, 16).toString('base64url')
  return {
    credentialId,
    cosePublicKey: cbor(cose).toString('base64url'),
    privateKey,
    alg,
    assert(challenge, opts = {}) {
      const rpIdHash = createHash('sha256').update(opts.rpId ?? defaults.rpId).digest()
      const authData = Buffer.concat([rpIdHash, Buffer.from([opts.flags ?? 0x05]), Buffer.from([0, 0, 0, 0])])
      const clientData = Buffer.from(JSON.stringify({
        type: opts.type ?? 'webauthn.get',
        challenge: Buffer.from(challenge).toString('base64url'),
        origin: opts.origin ?? defaults.origin,
        crossOrigin: false,
      }))
      const signed = Buffer.concat([authData, createHash('sha256').update(clientData).digest()])
      const signature = alg === 'EdDSA' ? sign(null, signed, privateKey) : sign('sha256', signed, privateKey)
      return {
        authenticatorData: authData.toString('base64url'),
        clientDataJSON: clientData.toString('base64url'),
        signature: signature.toString('base64url'),
      }
    },
  }
}
