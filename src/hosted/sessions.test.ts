/** Tests for the global sign-out client. */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { signOutEverywhere, describeSignOutResult } from './sessions'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

function mockFetch(response: Partial<Response> & { json?: () => Promise<unknown> }) {
  const spy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}), ...response })
  globalThis.fetch = spy as unknown as typeof fetch
  return spy
}

describe('signOutEverywhere', () => {
  it('posts to logout-all with the session cookie and returns the count', async () => {
    const spy = mockFetch({ json: () => Promise.resolve({ success: true, destroyed: 7 }) })

    expect(await signOutEverywhere()).toEqual({ destroyed: 7 })
    expect(spy).toHaveBeenCalledWith('/api/auth/logout-all', {
      method: 'POST',
      // Without credentials the cookie never arrives and the call is a no-op.
      credentials: 'include',
    })
  })

  it('treats a missing or non-numeric count as zero rather than failing', async () => {
    mockFetch({ json: () => Promise.resolve({ success: true }) })
    expect(await signOutEverywhere()).toEqual({ destroyed: 0 })

    mockFetch({ json: () => Promise.resolve({ destroyed: 'lots' }) })
    expect(await signOutEverywhere()).toEqual({ destroyed: 0 })
  })

  it('throws when the server refuses, so the caller never reports a sign-out that did not happen', async () => {
    mockFetch({ ok: false, status: 401 })
    await expect(signOutEverywhere()).rejects.toThrow('401')
  })
})

describe('describeSignOutResult', () => {
  it('counts the other sessions, not the caller\'s own', () => {
    // The caller's session is always one of the destroyed rows.
    expect(describeSignOutResult(1)).toBe('Signed out. No other sessions were open.')
    expect(describeSignOutResult(2)).toBe('Signed out, and 1 other session was ended.')
    expect(describeSignOutResult(8)).toBe('Signed out, and 7 other sessions were ended.')
  })

  it('does not go negative when the server reports nothing destroyed', () => {
    expect(describeSignOutResult(0)).toBe('Signed out. No other sessions were open.')
  })
})
