/**
 * Connector version floors (docs/RELAY-HARDENING.md §4).
 *
 * A connector is the part of the system the relay cannot upgrade: it runs on
 * someone's machine and may be months old. Some guarantees (share
 * enforcement today; signed intents and end-to-end encryption later) only
 * hold if the connector enforces them, so a connector below a floor is
 * refused traffic rather than trusted. It stays connected, so the UI can say
 * "update required" instead of "offline" and an old connector doesn't fall
 * into a reconnect loop.
 *
 * Floors only ever go up. Check `connectorVersions` in `/api/admin/stats`
 * before raising one.
 */

/** Connectors older than this predate the sharing enforcement mirror. */
export const MIN_SUPPORTED_CONNECTOR_VERSION = '0.9.0'

/**
 * Features a connector can advertise in `ConnectorHello.capabilities.features`
 * and a workspace can require.
 */
export const CONNECTOR_CAPABILITIES = ['intents', 'e2e', 'credentialClass'] as const
export type ConnectorCapability = (typeof CONNECTOR_CAPABILITIES)[number]

export interface ConnectorFloors {
  /** Anything older is refused traffic everywhere. */
  base: string
  /**
   * Oldest connector whose claim of a capability is believed. A capability
   * with no floor hasn't shipped: no connector has it yet.
   */
  capabilities: Partial<Record<ConnectorCapability, string>>
}

export const CONNECTOR_FLOORS: ConnectorFloors = {
  base: MIN_SUPPORTED_CONNECTOR_VERSION,
  capabilities: {
    // Signed intents (L1) are enforced from the release that carries slice 7
    // (signed-intents spec §6.8). Raise this if that release is numbered higher.
    intents: '0.10.6',
    // e2e: set when the end-to-end handshake (L2) ships.
    // credentialClass: set when connectors declare their credential class.
  },
}

/** Why a machine needs a newer connector before the relay serves it. */
export interface UpdateRequired {
  /** Lowest connector version that would clear every floor that applies. */
  minimum: string
  /** Required capabilities the connector lacks (empty when only `base` applies). */
  missing: ConnectorCapability[]
  reason: string
}

const CAPABILITY_REASONS: Record<ConnectorCapability, string> = {
  intents: 'needed for signed control',
  e2e: 'needed for end-to-end encryption',
  credentialClass: 'needed to declare which credentials the machine uses',
}

export function isConnectorCapability(value: unknown): value is ConnectorCapability {
  return typeof value === 'string' && (CONNECTOR_CAPABILITIES as readonly string[]).includes(value)
}

/**
 * A connector has a capability when it advertises it *and* its version is at
 * or above that capability's floor. A claim below the floor (or for a
 * capability that hasn't shipped) doesn't count.
 */
export function hasCapability(
  version: string | null | undefined,
  advertised: readonly string[],
  capability: ConnectorCapability,
  floors: ConnectorFloors = CONNECTOR_FLOORS,
): boolean {
  const floor = floors.capabilities[capability]
  if (floor === undefined || !advertised.includes(capability)) return false
  return !isConnectorOutdated(version, floor)
}

/**
 * Whether the relay must refuse a connector's traffic, and why. Null when
 * the connector clears the base floor and has every capability `required`
 * names.
 */
export function connectorUpdateRequired(
  version: string | null | undefined,
  advertised: readonly string[],
  required: readonly ConnectorCapability[],
  floors: ConnectorFloors = CONNECTOR_FLOORS,
): UpdateRequired | null {
  const missing = required.filter(cap => !hasCapability(version, advertised, cap, floors))
  const belowBase = isConnectorOutdated(version, floors.base)
  if (!belowBase && missing.length === 0) return null

  let minimum = floors.base
  for (const cap of missing) {
    const floor = floors.capabilities[cap]
    if (floor !== undefined && isConnectorOutdated(minimum, floor)) minimum = floor
  }
  const reasons = missing.map(cap => CAPABILITY_REASONS[cap])
  const reason = belowBase
    ? `connector ${version ?? 'of unknown version'} is older than the minimum ${floors.base}`
    : `the workspace requires ${missing.join(', ')} (${reasons.join('; ')})`
  return { minimum, missing, reason }
}

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
