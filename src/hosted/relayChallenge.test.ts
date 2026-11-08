/** The browser's wrapping of relay passkey challenges must match what the relay verifies against. */
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { separateRelayChallenge } from './relayChallenge'
import { separatedChallenge } from '../../server/relay/webauthn-routes'

describe('relay challenge separation', () => {
  it('produces the same challenge on both sides, pinned to a fixed vector', async () => {
    const challenge = Buffer.alloc(32, 7).toString('base64url')
    const browser = await separateRelayChallenge({ challenge, allowCredentials: [], rpId: 'relay.test', userVerification: 'required' })
    expect(browser.challenge).toBe(separatedChallenge(challenge))
    expect(browser.challenge).toBe(VECTOR)
    // Never the raw challenge.
    expect(browser.challenge).not.toBe(challenge)
  })
})

const VECTOR = 'Xyj1gdxSPHL8Rao-Jwi6c1oq_cvvewdW6PZyf7xkLZg'
