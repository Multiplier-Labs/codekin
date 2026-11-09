/** Telling a client's mistake from a server error, for the relay's error handler. */

/** The 4xx status of an error a client caused (body-parser's), or null for a server error. */
export function clientErrorStatus(err: unknown): number | null {
  const e = err as { status?: unknown; statusCode?: unknown; type?: unknown } | null
  const status = typeof e?.status === 'number' ? e.status : typeof e?.statusCode === 'number' ? e.statusCode : null
  if (status === null || status < 400 || status >= 500) return null
  // Only body-parser's own errors, which say what kind they are.
  return typeof e?.type === 'string' && e.type.length > 0 ? status : null
}
