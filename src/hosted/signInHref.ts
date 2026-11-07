/**
 * The GitHub sign-in URL, carrying where to come back to.
 *
 * Only the pairing approval page (`/pair?code=…`, opened from the URL that
 * `codekin relay login` prints) and the desktop app's sign-in approval
 * (`/desktop-auth?request=…`) have anything worth returning to after the
 * OAuth round trip. The relay re-validates the value against its own strict
 * allowlist before storing it in the session (server/relay/return-to.ts), so
 * this is a convenience, not the security boundary.
 */
export function githubSignInHref(location: Pick<Location, 'pathname' | 'search'>): string {
  const start = '/api/auth/github/start'
  if (location.pathname === '/desktop-auth') {
    const request = new URLSearchParams(location.search).get('request')
    return request && /^[0-9a-f-]{36}$/.test(request)
      ? `${start}?returnTo=${encodeURIComponent(`/desktop-auth?request=${request}`)}`
      : start
  }
  if (location.pathname !== '/pair') return start
  const code = new URLSearchParams(location.search).get('code')
  const returnTo = code && /^[A-Za-z0-9-]{1,32}$/.test(code) ? `/pair?code=${code}` : '/pair'
  return `${start}?returnTo=${encodeURIComponent(returnTo)}`
}
