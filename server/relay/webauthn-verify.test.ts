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

  it('reads only well-formed COSE keys, and gives passkeys stable key ids', () => {
    expect(coseToKey(softPasskey('ES256').cosePublicKey)?.alg).toBe(-7)
    expect(coseToKey('not-cbor')).toBeNull()
    expect(coseToKey(Buffer.from([0xa0]).toString('base64url'))).toBeNull()
    const p = softPasskey()
    expect(keyIdForCoseKey(p.cosePublicKey)).toHaveLength(22)
    expect(keyIdForCoseKey(p.cosePublicKey)).toBe(keyIdForCoseKey(p.cosePublicKey))
  })
})
