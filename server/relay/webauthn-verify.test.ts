/** Tests for the machine's dependency-free WebAuthn assertion check, against @simplewebauthn/server. */
import { describe, it, expect } from 'vitest'
import { randomBytes } from 'crypto'
import { verifyAuthenticationResponse } from '@simplewebauthn/server'
import { coseToKey, keyIdForCoseKey, verifyPasskeyAssertion } from './webauthn-verify.js'
import { softPasskey } from './__fixtures__/authenticator.js'
import type { Alg } from './__fixtures__/authenticator.js'

const ORIGIN = 'https://relay.test'
const RP = 'relay.test'

describe('verifyPasskeyAssertion', () => {
  for (const alg of ['ES256', 'RS256', 'EdDSA'] as Alg[]) {
    it(`accepts a good ${alg} assertion, as @simplewebauthn/server does`, async () => {
      const passkey = softPasskey(alg)
      const challenge = randomBytes(32)
      const assertion = passkey.assert(challenge)
      expect(verifyPasskeyAssertion(assertion, { challenge, origin: ORIGIN, rpId: RP, cosePublicKey: passkey.cosePublicKey })).toBeNull()
      const reference = await verifyAuthenticationResponse({
        response: {
          id: passkey.credentialId, rawId: passkey.credentialId, type: 'public-key', clientExtensionResults: {},
          response: { authenticatorData: assertion.authenticatorData, clientDataJSON: assertion.clientDataJSON, signature: assertion.signature },
        },
        expectedChallenge: challenge.toString('base64url'),
        expectedOrigin: ORIGIN,
        expectedRPID: RP,
        requireUserVerification: true,
        credential: { id: passkey.credentialId, publicKey: Buffer.from(passkey.cosePublicKey, 'base64url'), counter: 0 },
      })
      expect(reference.verified).toBe(true)
    })
  }

  it('refuses each way an assertion can be wrong', () => {
    const passkey = softPasskey()
    const other = softPasskey()
    const challenge = randomBytes(32)
    const expected = { challenge, origin: ORIGIN, rpId: RP, cosePublicKey: passkey.cosePublicKey }
    expect(verifyPasskeyAssertion(passkey.assert(randomBytes(32)), expected)).toBe('wrong_challenge')
    expect(verifyPasskeyAssertion(passkey.assert(challenge, { origin: 'https://evil.test' }), expected)).toBe('wrong_origin')
    expect(verifyPasskeyAssertion(passkey.assert(challenge, { rpId: 'evil.test' }), expected)).toBe('wrong_rp')
    expect(verifyPasskeyAssertion(passkey.assert(challenge, { type: 'webauthn.create' }), expected)).toBe('wrong_type')
    expect(verifyPasskeyAssertion(passkey.assert(challenge, { flags: 0x01 }), expected)).toBe('not_verified')
    expect(verifyPasskeyAssertion(passkey.assert(challenge, { flags: 0x04 }), expected)).toBe('not_present')
    // A relay offering its own public key for someone else's assertion.
    expect(verifyPasskeyAssertion(passkey.assert(challenge), { ...expected, cosePublicKey: other.cosePublicKey })).toBe('bad_signature')
    expect(verifyPasskeyAssertion({ ...passkey.assert(challenge), signature: 'AAAA' }, expected)).toBe('bad_signature')
    expect(verifyPasskeyAssertion({ authenticatorData: '', clientDataJSON: 'x', signature: 'y' }, expected)).toBe('malformed')
    expect(verifyPasskeyAssertion(passkey.assert(challenge), { ...expected, cosePublicKey: 'oQE' })).toBe('bad_key')
  })

  it('refuses weak RSA keys and ambiguous CBOR', () => {
    const cose = (entries: Array<[number, number | Buffer]>) => {
      // Tiny CBOR map encoder for these cases.
      const head = (major: number, n: number) => n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255])
      const enc = (v: number | Buffer) => typeof v === 'number' ? (v >= 0 ? head(0, v) : head(1, -1 - v)) : Buffer.concat([head(2, v.length), v])
      return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, v]) => [enc(k), enc(v)])]).toString('base64url')
    }
    const n = Buffer.alloc(256, 0xab)
    expect(coseToKey(cose([[1, 3], [3, -257], [-1, n], [-2, Buffer.from([1, 0, 1])]]))).not.toBeNull()
    expect(coseToKey(cose([[1, 3], [3, -257], [-1, n], [-2, Buffer.from([1])]]))).toBeNull()
    expect(coseToKey(cose([[1, 3], [3, -257], [-1, Buffer.concat([Buffer.from([0]), n.subarray(1)])], [-2, Buffer.from([1, 0, 1])]]))).toBeNull()
    const p = softPasskey()
    const decoded = Buffer.from(p.cosePublicKey, 'base64url')
    // Same key with a duplicated "alg" entry appended: a second encoding, refused.
    const dup = Buffer.concat([Buffer.from([decoded[0] + 1]), decoded.subarray(1), Buffer.from([0x03, 0x26])])
    expect(coseToKey(dup.toString('base64url'))).toBeNull()
  })

  it('reads only well-formed COSE keys, and gives passkeys stable key ids', () => {
    expect(coseToKey(softPasskey('ES256').cosePublicKey)?.alg).toBe(-7)
    expect(coseToKey('not-cbor')).toBeNull()
    expect(coseToKey(Buffer.from([0xa0]).toString('base64url'))).toBeNull()
    const p = softPasskey()
    expect(keyIdForCoseKey(p.cosePublicKey)).toHaveLength(22)
    expect(keyIdForCoseKey(p.cosePublicKey)).toBe(keyIdForCoseKey(p.cosePublicKey))
  })
})
