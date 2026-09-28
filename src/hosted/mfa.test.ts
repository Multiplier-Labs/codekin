/** Tests for stepUpFetch: when it asks the user to re-verify, and that it retries exactly once. */
// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest'
import { StepUpCancelled, setStepUpHandler, stepUpFetch } from './mfa'

const respond = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))

afterEach(() => {
  setStepUpHandler(null)
  vi.unstubAllGlobals()
})

describe('stepUpFetch', () => {
  it('passes ordinary responses straight through', async () => {
    const handler = vi.fn()
    setStepUpHandler(handler)
    vi.stubGlobal('fetch', vi.fn(() => respond(401, { error: 'Unauthorized' })))
    expect((await stepUpFetch('/api/x')).status).toBe(401)
    expect(handler).not.toHaveBeenCalled()
  })

  it('asks for the method the relay names, then retries once', async () => {
    const handler = vi.fn(() => Promise.resolve())
    setStepUpHandler(handler)
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => respond(401, { error: 'step_up_required', method: 'mfa' }))
      .mockImplementationOnce(() => respond(200, { ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    const res = await stepUpFetch('/api/auth/device-link/start', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(handler).toHaveBeenCalledWith('mfa')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('surfaces a dismissed prompt as StepUpCancelled without retrying', async () => {
    setStepUpHandler(() => Promise.reject(new StepUpCancelled()))
    const fetchMock = vi.fn(() => respond(401, { error: 'step_up_required', method: 'github' }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(stepUpFetch('/api/x')).rejects.toBeInstanceOf(StepUpCancelled)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns the refusal as-is when no dialog is mounted', async () => {
    vi.stubGlobal('fetch', vi.fn(() => respond(401, { error: 'step_up_required', method: 'mfa' })))
    expect((await stepUpFetch('/api/x')).status).toBe(401)
  })
})
