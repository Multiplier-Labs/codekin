/**
 * WebAuthn assertion verification on the machine
 * (docs/RELAY-SIGNED-INTENTS-AND-E2E-SPEC.md §4.2, §5.4, §6.4 step 3, §6.6).
 *
 * The connector ships in the npm package and can't depend on the relay's
 * @simplewebauthn/server, so this is a small, dependency-free verifier for
 * the one ceremony the machine needs: a get() assertion over a challenge it
 * computed itself, from a passkey whose COSE public key is in its device
 * list. Tests cross-check it against @simplewebauthn/server.
 *
 * Checked: clientDataJSON type, challenge, origin (and not cross-origin);
 * authenticatorData RP ID hash and the user-present and user-verified flags;
 * the signature over authenticatorData ‖ SHA-256(clientDataJSON). The
 * signature counter is ignored: synced passkeys report 0 (spec §6.4).
 * Algorithms: ES256 (-7), RS256 (-257), EdDSA/Ed25519 (-8).
 */

import { createHash, createPublicKey, verify } from 'crypto'
import type { KeyObject } from 'crypto'

export interface PasskeyAssertion {
  /** base64url */
  authenticatorData: string
  /** base64url of the UTF-8 JSON */
  clientDataJSON: string
  /** base64url, as the authenticator returned it (DER for ECDSA) */
  signature: string
}

export interface ExpectedAssertion {
  /** The challenge bytes the browser passed to navigator.credentials.get(). */
  challenge: Uint8Array
  /** e.g. https://app.codekin.ai */
  origin: string
  /** e.g. app.codekin.ai */
  rpId: string
  /** base64url COSE_Key, as the relay stores it. */
  cosePublicKey: string
}

export type AssertionFailure =
  | 'malformed'
  | 'wrong_type'
  | 'wrong_challenge'
  | 'wrong_origin'
  | 'wrong_rp'
  | 'not_present'
  | 'not_verified'
  | 'bad_key'
  | 'bad_signature'

// --- A minimal CBOR decoder, enough for a COSE_Key ---------------------------

type Cbor = number | bigint | Uint8Array | string | Cbor[] | Map<Cbor, Cbor> | boolean | null

function decodeCbor(bytes: Uint8Array): Cbor {
  let pos = 0
  const need = (n: number) => { if (pos + n > bytes.length) throw new Error('truncated CBOR') }
  const readLength = (info: number): number => {
    if (info < 24) return info
    const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : -1
    if (size < 0) throw new Error('unsupported CBOR length')
    need(size)
    let value = 0
    for (let i = 0; i < size; i++) value = value * 256 + bytes[pos + i]
    pos += size
    if (!Number.isSafeInteger(value)) throw new Error('CBOR length too large')
    return value
  }
  const item = (depth: number): Cbor => {
    if (depth > 8) throw new Error('CBOR too deep')
    need(1)
    const initial = bytes[pos++]
    const major = initial >> 5
    const info = initial & 31
    switch (major) {
      case 0: return readLength(info)
      case 1: return -1 - readLength(info)
      case 2: { const n = readLength(info); need(n); const out = bytes.slice(pos, pos + n); pos += n; return out }
      case 3: { const n = readLength(info); need(n); const out = new TextDecoder().decode(bytes.slice(pos, pos + n)); pos += n; return out }
      case 4: { const n = readLength(info); const out: Cbor[] = []; for (let i = 0; i < n; i++) out.push(item(depth + 1)); return out }
      case 5: {
        const n = readLength(info)
        const out = new Map<Cbor, Cbor>()
        for (let i = 0; i < n; i++) {
          const k = item(depth + 1)
          // Duplicate keys would let one key have several encodings (and key ids).
          if (out.has(k)) throw new Error('duplicate CBOR map key')
          out.set(k, item(depth + 1))
        }
        return out
      }
      case 7:
        if (info === 20) return false
        if (info === 21) return true
        if (info === 22) return null
        throw new Error('unsupported CBOR simple value')
      default:
        throw new Error('unsupported CBOR type')
    }
  }
  const value = item(0)
  if (pos !== bytes.length) throw new Error('trailing CBOR bytes')
  return value
}

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')

export const COSE_ALG = { ES256: -7, RS256: -257, EdDSA: -8 } as const

/** A Node public key and how to verify with it, from a base64url COSE_Key. */
export function coseToKey(cosePublicKey: string): { key: KeyObject; alg: number } | null {
  try {
    const map = decodeCbor(Buffer.from(cosePublicKey, 'base64url'))
    if (!(map instanceof Map)) return null
    const kty = map.get(1)
    const alg = map.get(3)
    if (kty === 2 && alg === COSE_ALG.ES256) {
      const crv = map.get(-1)
      const x = map.get(-2)
      const y = map.get(-3)
      if (crv !== 1 || !(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) return null
      return { key: createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64url(x), y: b64url(y) }, format: 'jwk' }), alg }
    }
    if (kty === 3 && alg === COSE_ALG.RS256) {
      const n = map.get(-1)
      const e = map.get(-2)
      // At least 2048 bits with no leading zero to pad the length, and the
      // usual exponent (e = 1 would make every signature valid).
      if (!(n instanceof Uint8Array) || !(e instanceof Uint8Array) || n.length < 256 || n[0] === 0) return null
      if (e.length !== 3 || e[0] !== 1 || e[1] !== 0 || e[2] !== 1) return null
      return { key: createPublicKey({ key: { kty: 'RSA', n: b64url(n), e: b64url(e) }, format: 'jwk' }), alg }
    }
    if (kty === 1 && alg === COSE_ALG.EdDSA) {
      const crv = map.get(-1)
      const x = map.get(-2)
      if (crv !== 6 || !(x instanceof Uint8Array) || x.length !== 32) return null
      return { key: createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64url(x) }, format: 'jwk' }), alg }
    }
    return null
  } catch {
    return null
  }
}

/** Key id for a passkey: base64url(SHA-256(COSE_Key bytes))[0:22], like browser keys over SPKI. */
export function keyIdForCoseKey(cosePublicKey: string): string {
  return createHash('sha256').update(Buffer.from(cosePublicKey, 'base64url')).digest('base64url').slice(0, 22)
}

function strictB64url(value: unknown): Buffer | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384 || !/^[A-Za-z0-9_-]+$/.test(value)) return null
  return Buffer.from(value, 'base64url')
}

const FLAG_UP = 0x01
const FLAG_UV = 0x04

/** Verify a passkey assertion; null when it holds, otherwise why not. */
export function verifyPasskeyAssertion(assertion: PasskeyAssertion, expected: ExpectedAssertion): AssertionFailure | null {
  const authData = strictB64url(assertion.authenticatorData)
  const clientDataBytes = strictB64url(assertion.clientDataJSON)
  const signature = strictB64url(assertion.signature)
  if (!authData || !clientDataBytes || !signature || authData.length < 37) return 'malformed'

  let clientData: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown }
  try {
    clientData = JSON.parse(clientDataBytes.toString('utf-8')) as typeof clientData
  } catch {
    return 'malformed'
  }
  if (clientData.type !== 'webauthn.get') return 'wrong_type'
  if (clientData.challenge !== b64url(expected.challenge)) return 'wrong_challenge'
  if (clientData.origin !== expected.origin || clientData.crossOrigin === true) return 'wrong_origin'

  const rpIdHash = createHash('sha256').update(expected.rpId, 'utf-8').digest()
  if (!authData.subarray(0, 32).equals(rpIdHash)) return 'wrong_rp'
  const flags = authData[32]
  if (!(flags & FLAG_UP)) return 'not_present'
  if (!(flags & FLAG_UV)) return 'not_verified'

  const parsed = coseToKey(expected.cosePublicKey)
  if (!parsed) return 'bad_key'
  const signed = Buffer.concat([authData, createHash('sha256').update(clientDataBytes).digest()])
  let ok: boolean
  try {
    ok = parsed.alg === COSE_ALG.EdDSA
      ? verify(null, signed, parsed.key, signature)
      : verify('sha256', signed, parsed.alg === COSE_ALG.ES256 ? { key: parsed.key, dsaEncoding: 'der' } : parsed.key, signature)
  } catch {
    ok = false
  }
  return ok ? null : 'bad_signature'
}
