/** Tests for the reasons registerPasskey reports, so the UI can say what went wrong. */
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { registerPasskey, describePasskeySetupError, PasskeySetupError } from './passkeys'

function respond(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status }))))
}

afterEach(() => { vi.unstubAllGlobals() })

describe('registerPasskey failures', () => {
  it('reports a step-up refusal as step_up', async () => {
    respond(401, { error: 'step_up_required', method: 'mfa' })
    await expect(registerPasskey('iPhone')).rejects.toMatchObject({ reason: 'step_up' })
  })

  it('reports any other 401 as an ended session', async () => {
    respond(401, { error: 'Unauthorized' })
    await expect(registerPasskey('iPhone')).rejects.toMatchObject({ reason: 'session' })
  })

  it('reports a server error as unknown', async () => {
    respond(500, {})
    await expect(registerPasskey('iPhone')).rejects.toBeInstanceOf(PasskeySetupError)
  })
})

describe('describePasskeySetupError', () => {
  const named = (name: string) => Object.assign(new Error(name), { name })

  it('stays quiet when the user dismissed the prompt', () => {
    expect(describePasskeySetupError(named('NotAllowedError'))).toBeNull()
    expect(describePasskeySetupError(named('AbortError'))).toBeNull()
  })

  it('names the cause it can tell', () => {
    expect(describePasskeySetupError(new PasskeySetupError('step_up', ''))).toContain('Settings → Devices')
    expect(describePasskeySetupError(new PasskeySetupError('step_up', ''), 'settings')).not.toContain('Settings → Devices')
    expect(describePasskeySetupError(named('SecurityError'))).toContain('usual https address')
    expect(describePasskeySetupError(named('InvalidStateError'))).toContain('already has a passkey')
  })
})
