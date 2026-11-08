/**
 * Owner-signed share grants, from the owner's browser
 * (docs/RELAY-SIGNED-INTENTS-AND-E2E-SPEC.md §6.7).
 *
 * Sharing a session asks the relay for a share; the owner then signs a grant
 * naming the session, the grantee, the permissions, the grantee's browser
 * keys and an expiry (at most 30 days, never past the share's). The machine
 * accepts what the relay says only where the owner's grant agrees, and only
 * from the keys the grant names.
 *
 * Renewal is silent while the owner's browser is open, but only for the same
 * key set: a grantee's new device always needs the owner to allow it.
 */

import {
  GRANT_ACTION, GRANT_REVOKE_ACTION, MAX_GRANT_LIFETIME_MS, grantNeedsStepUp, grantPayload, grantRevokePayload,
} from '../../server/relay/intent-actions'
import type { GrantBody, SignedIntent } from '../../server/relay/intent-actions'
import { currentUserId, defaultBrowserLabel, getOrCreateBrowserKey, trustStorage } from './deviceTrust'
import { workspaceHeaders } from './workspace'

/** The parts of the hosted transport grants need (HostedRelayTransport). */
export interface GrantTransport {
  signIntent(intent: { action: string; sessionId: string | null; payload: Uint8Array; stepUp?: boolean }): Promise<SignedIntent | null>
  sendDeviceFrame(kind: 'enrol_grant_revoke', payload: unknown): Promise<unknown>
}

export interface ShareWithGrant {
  id: string
  machineId: string
  localSessionId: string
  granteeUserId: string | null
  permissions: string[]
  expiresAt: string | null
  signedGrant: { expiresAt: number; permissions: string[]; keyIds: string[] } | null
}

export interface GranteeKey {
  keyId: string
  spki: string
  label: string
  lastSeenAt: string | null
}

/** Renew a grant this long before it runs out. */
export const RENEW_WITHIN_MS = 7 * 24 * 60 * 60_000

export class GrantError extends Error {
  readonly code: 'not_confirmed' | 'no_keys' | 'rejected'
  constructor(code: GrantError['code'], message: string) {
    super(message)
    this.name = 'GrantError'
    this.code = code
  }
}

export async function fetchGranteeKeys(shareId: string): Promise<GranteeKey[]> {
  const res = await fetch(`/api/shares/${encodeURIComponent(shareId)}/grantee-keys`, { credentials: 'include' })
  if (!res.ok) return []
  const body = await res.json() as { keys?: GranteeKey[] }
  return Array.isArray(body.keys) ? body.keys : []
}

/** The grant for a share and key set, expiring in 30 days or with the share, whichever is first. */
export function buildGrant(share: ShareWithGrant, keys: Array<Pick<GranteeKey, 'keyId' | 'spki'>>, now = Date.now()): GrantBody {
  const shareExpiry = share.expiresAt ? Date.parse(share.expiresAt) : Infinity
  return {
    grantId: share.id,
    sessionId: share.localSessionId,
    granteeUserId: share.granteeUserId ?? '',
    permissions: share.permissions,
    granteeKeys: keys.map(k => ({ keyId: k.keyId, spki: k.spki })),
    expiresAt: Math.min(now + MAX_GRANT_LIFETIME_MS, shareExpiry),
  }
}

/**
 * Sign and store the grant for a share, naming `keys` (the grantee devices
 * the owner saw and allowed). Shell approvals need the owner's passkey when
 * the machine has one (§6.6).
 */
export async function signShareGrant(transport: GrantTransport, share: ShareWithGrant, keys: Array<Pick<GranteeKey, 'keyId' | 'spki'>>): Promise<ShareWithGrant> {
  if (keys.length === 0) throw new GrantError('no_keys', 'They have no browser to allow yet. Ask them to open the session once, then come back here.')
  const grant = buildGrant(share, keys)
  const text = JSON.stringify(grant)
  const intent = await transport.signIntent({
    action: GRANT_ACTION, sessionId: share.localSessionId, payload: grantPayload(text), stepUp: grantNeedsStepUp(grant.permissions),
  })
  if (!intent) throw new GrantError('not_confirmed', 'Confirm this browser on the computer first (Settings → Machines), then share again.')
  const res = await fetch(`/api/shares/${encodeURIComponent(share.id)}/grant`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...workspaceHeaders() },
    body: JSON.stringify({ grant: text, intent }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null
    throw new GrantError('rejected', body?.error ?? `Could not store the grant (${res.status})`)
  }
  return ((await res.json()) as { share: ShareWithGrant }).share
}

/** Tell the machine itself that a grant is revoked, so a relay replaying it gets nowhere. */
export async function revokeShareGrant(transport: GrantTransport, grantId: string): Promise<void> {
  const intent = await transport.signIntent({ action: GRANT_REVOKE_ACTION, sessionId: null, payload: grantRevokePayload(grantId) })
  if (!intent) return
  await transport.sendDeviceFrame('enrol_grant_revoke', { grantId, intent })
}

export type GrantStatus =
  | { kind: 'signed'; keyIds: string[]; expiresAt: number }
  /** The grantee has keys the grant doesn't name: the owner must allow them. */
  | { kind: 'new_device'; added: GranteeKey[]; keys: GranteeKey[] }
  /** Never signed (or permissions changed since). */
  | { kind: 'unsigned'; keys: GranteeKey[] }

/** Where a share's grant stands against the grantee's current devices. */
export function grantStatus(share: ShareWithGrant, keys: GranteeKey[]): GrantStatus {
  if (!share.signedGrant) return { kind: 'unsigned', keys }
  const signed = new Set(share.signedGrant.keyIds)
  const added = keys.filter(k => !signed.has(k.keyId))
  if (added.length > 0) return { kind: 'new_device', added, keys }
  return { kind: 'signed', keyIds: share.signedGrant.keyIds, expiresAt: share.signedGrant.expiresAt }
}

/**
 * Re-sign grants that run out within a week, for exactly the keys they
 * already name (D3). Grants whose key set changed are left for the owner.
 * Returns how many were renewed.
 */
export async function renewGrants(transport: GrantTransport, machineId: string, now = Date.now()): Promise<number> {
  const res = await fetch('/api/shares', { credentials: 'include', headers: workspaceHeaders() })
  if (!res.ok) return 0
  const shares = ((await res.json()) as { shared?: ShareWithGrant[] }).shared ?? []
  let renewed = 0
  for (const share of shares) {
    if (share.machineId !== machineId || !share.signedGrant || share.signedGrant.expiresAt - now > RENEW_WITHIN_MS) continue
    const keys = await fetchGranteeKeys(share.id)
    const kept = keys.filter(k => share.signedGrant?.keyIds.includes(k.keyId))
    if (kept.length === 0) continue
    try {
      await signShareGrant(transport, share, kept)
      renewed += 1
    } catch {
      // Not confirmed here, or the relay refused: try again next time.
    }
  }
  return renewed
}

/**
 * Register this browser's key with the relay, so owners sharing a session
 * with this user can name it in their grant. Harmless to repeat.
 */
export async function registerThisBrowser(): Promise<void> {
  const userId = await currentUserId()
  if (!userId) return
  const key = await getOrCreateBrowserKey(userId, trustStorage())
  await fetch('/api/device-keys', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spki: key.spki, label: defaultBrowserLabel() }),
  }).catch(() => {})
}
