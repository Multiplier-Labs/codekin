/**
 * Global sign-out for the hosted app.
 *
 * The relay keeps browser sessions as server-side rows, so a signed cookie
 * stays usable until its row is deleted — signing cookies stops forgery, not
 * replay. `POST /api/auth/logout-all` deletes every row for the caller and
 * closes their live relay sockets; this is the only way to reach a cookie that
 * is no longer in the browser that made it.
 */

/** Outcome of a global sign-out: how many stored sessions were destroyed. */
export interface SignOutEverywhereResult {
  destroyed: number
}

export async function signOutEverywhere(): Promise<SignOutEverywhereResult> {
  const res = await fetch('/api/auth/logout-all', {
    method: 'POST',
    credentials: 'include',
  })
  if (!res.ok) {
    throw new Error(`Global sign-out failed (${res.status})`)
  }
  const data = (await res.json()) as { destroyed?: unknown }
  // The count is for reassurance, not correctness: a server that answers OK
  // without one has still done the revocation.
  return { destroyed: typeof data.destroyed === 'number' ? data.destroyed : 0 }
}

/**
 * Phrase the result for the confirmation the user sees.
 *
 * The caller's own session is one of the destroyed rows, so the interesting
 * number is how many *other* sessions went with it.
 */
export function describeSignOutResult(destroyed: number): string {
  const others = Math.max(0, destroyed - 1)
  if (others === 0) return 'Signed out. No other sessions were open.'
  if (others === 1) return 'Signed out, and 1 other session was ended.'
  return `Signed out, and ${others} other sessions were ended.`
}
