/**
 * The byte-level pieces of the enrolment ceremony
 * (docs/RELAY-SIGNED-INTENTS-AND-E2E-SPEC.md §5.2), shared by the connector
 * and mirrored exactly by the browser (src/hosted/deviceTrust.ts). A test
 * vector in each side's tests pins that they agree.
 *
 * Every hashed or signed message is a transcript: a domain-separation label
 * followed by length-prefixed fields (4-byte big-endian length, then the
 * bytes), so no two different field lists can encode to the same bytes.
 *
 *   C     = SHA-256(T("ck-enrol-commit-v1", SPKI(kB), P, label, nonceB))
 *   sigM  = sign_kM(T("ck-enrol-challenge-v1", enrolId, C, nonceM))
 *   popB  = sign_kB(T("ck-enrol-pop-v1", enrolId, nonceM))
 *   SAS   = base32(SHA-256(T("ck-sas-v1", SPKI(kM), SPKI(kB), P, nonceB, nonceM)))[0:8]
 *   sigR  = sign_kM(T("ck-enrol-result-v1", enrolId, SPKI(kB), outcome))
 *
 * P is the passkey list, encoded as UTF-8 JSON of [credentialId,
 * cosePublicKey, rpId] triples. Passkeys join the ceremony in slice 5; until
 * then it is always "[]". Signatures are ECDSA P-256 / SHA-256 in IEEE P1363
 * form (r‖s, 64 bytes), which is what WebCrypto produces.
 */

import { createHash, createPublicKey, sign, timingSafeEqual, verify } from 'crypto'
import type { KeyObject } from 'crypto'

export const COMMIT_LABEL = 'ck-enrol-commit-v1'
export const CHALLENGE_LABEL = 'ck-enrol-challenge-v1'
export const POP_LABEL = 'ck-enrol-pop-v1'
export const SAS_LABEL = 'ck-sas-v1'
export const RESULT_LABEL = 'ck-enrol-result-v1'

/** Bytes in each side's nonce. */
export const NONCE_BYTES = 32
/** A SHA-256 digest. */
export const DIGEST_BYTES = 32
/** An IEEE P1363 P-256 signature. */
export const SIGNATURE_BYTES = 64
/** Longest label a browser may give itself. */
export const MAX_LABEL_CHARS = 64

export type Part = Uint8Array | string

/** T(label, ...fields): length-prefixed concatenation. */
export function transcript(label: string, ...parts: Part[]): Buffer {
  const chunks: Buffer[] = []
  for (const part of [label, ...parts]) {
    const bytes = typeof part === 'string' ? Buffer.from(part, 'utf-8') : Buffer.from(part)
    const length = Buffer.alloc(4)
    length.writeUInt32BE(bytes.length)
    chunks.push(length, bytes)
  }
  return Buffer.concat(chunks)
}

export interface EnrolPasskey {
  credentialId: string
  cosePublicKey: string
  rpId: string
}

export function encodePasskeys(passkeys: readonly EnrolPasskey[]): string {
  return JSON.stringify(passkeys.map(p => [p.credentialId, p.cosePublicKey, p.rpId]))
}

export function sha256(data: Uint8Array): Buffer {
  return createHash('sha256').update(data).digest()
}

export function commitment(spkiB: Uint8Array, passkeys: readonly EnrolPasskey[], label: string, nonceB: Uint8Array): Buffer {
  return sha256(transcript(COMMIT_LABEL, spkiB, encodePasskeys(passkeys), label, nonceB))
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** RFC 4648 base32, no padding. */
export function base32(bytes: Uint8Array): string {
  let out = ''
  let bits = 0
  let value = 0
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
    value &= (1 << bits) - 1
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

/** The 8-character (40-bit) code, without the display hyphen. */
export function shortAuthString(
  spkiM: Uint8Array,
  spkiB: Uint8Array,
  passkeys: readonly EnrolPasskey[],
  nonceB: Uint8Array,
  nonceM: Uint8Array,
): string {
  return base32(sha256(transcript(SAS_LABEL, spkiM, spkiB, encodePasskeys(passkeys), nonceB, nonceM))).slice(0, 8)
}

/** "K7QM2XPA" → "K7QM-2XPA". */
export function formatCode(sas: string): string {
  return `${sas.slice(0, 4)}-${sas.slice(4, 8)}`
}

/**
 * What a person typed, as a code to compare: upper case, spaces and hyphens
 * dropped. Null unless it is 8 base32 characters.
 */
export function normalizeCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, '')
  return /^[A-Z2-7]{8}$/.test(code) ? code : null
}

export function codesEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export function signP1363(key: KeyObject, data: Uint8Array): Buffer {
  return sign('sha256', data, { key, dsaEncoding: 'ieee-p1363' })
}

/** Verify with a public key given as SPKI DER; false on any malformed input. */
export function verifyP1363(spki: Uint8Array, data: Uint8Array, signature: Uint8Array): boolean {
  if (signature.length !== SIGNATURE_BYTES) return false
  try {
    const key = createPublicKey({ key: Buffer.from(spki), format: 'der', type: 'spki' })
    return verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, signature)
  } catch {
    return false
  }
}

/** Decode base64url and require an exact length; null otherwise. */
export function fromB64url(value: unknown, bytes?: number): Buffer | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value) || value.length > 4096) return null
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.toString('base64url') !== value) return null
  if (bytes !== undefined && decoded.length !== bytes) return null
  return decoded
}

/**
 * A label from the browser, accepted only as sent: it is part of the
 * commitment, so it can't be cleaned up here. No control or bidi-override
 * characters, no surrounding space, 1–64 characters.
 */
export function checkLabel(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_LABEL_CHARS) return null
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(value)) return null
  return value.trim() === value ? value : null
}
