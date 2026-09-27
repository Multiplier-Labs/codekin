/**
 * Where to send the browser after GitHub sign-in.
 *
 * A sign-in that starts on a page with work in progress — today only the
 * CLI-first pairing approval, `/pair?code=XXXX-XXXX` — should land back there
 * rather than on `/`. The destination is a redirect target, so it is held to
 * an allowlist, not sanitised: anything that is not exactly a known
 * same-origin path with its expected query value is dropped.
 *
 * Deliberately not accepted:
 * - `/link`: device-link claims run before the auth gate and carry their code
 *   in the URL fragment, which the server never sees; there is nothing to
 *   return to.
 * - Any `%`: the value arrives already URL-decoded once by Express, so a
 *   remaining `%` can only be a second encoding layer (e.g. `%2F%2Fevil`).
 * - Any other query key, repeated keys, fragments, backslashes, `//`, schemes
 *   or absolute URLs — none survive the pattern below.
 */

/** `/pair`, optionally with one `code` of the pairing-code alphabet. */
const PAIR_RETURN = /^\/pair(?:\?code=[A-Za-z0-9-]{1,32})?$/

const MAX_LENGTH = 64

export function validateReturnTo(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  if (raw.length === 0 || raw.length > MAX_LENGTH) return null
  return PAIR_RETURN.test(raw) ? raw : null
}
