/**
 * Connector version compatibility.
 *
 * A connector is the part of the system the hosted service cannot upgrade —
 * it runs on someone's laptop and may be months old. The hub therefore
 * treats an old connector as a warning to surface, not an error: it keeps
 * working, but the UI says so, because features added later (session
 * streaming, share enforcement) simply are not there.
 */

/** Connectors older than this predate the sharing enforcement mirror. */
export const MIN_SUPPORTED_CONNECTOR_VERSION = '0.9.0'

interface Semver {
  major: number
  minor: number
  patch: number
}

/** Parse `1.2.3` / `1.2.3-beta.1`. Returns null for anything unrecognized. */
export function parseVersion(version: string | null | undefined): Semver | null {
  if (!version) return null
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

/** Negative when a < b, zero when equal, positive when a > b. */
export function compareVersions(a: Semver, b: Semver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

/**
 * Whether a connector is behind the supported version. An unparsable or
 * missing version counts as outdated: a connector that cannot say what it
 * is predates the field being reliable.
 */
export function isConnectorOutdated(
  version: string | null | undefined,
  minimum = MIN_SUPPORTED_CONNECTOR_VERSION,
): boolean {
  const parsed = parseVersion(version)
  if (!parsed) return true
  const floor = parseVersion(minimum)
  if (!floor) return false
  return compareVersions(parsed, floor) < 0
}
