/**
 * Owner-signed share grants, from the owner's browser
 * (docs/RELAY-SIGNED-INTENTS-AND-E2E-SPEC.md §6.7).
 *
 * Sharing a session asks the relay for a share; the owner then signs a grant
 * naming the session, the grantee, the permissions, the grantee's browser
 * keys and an expiry. The machine accepts what the relay says only where the
 * owner's grant agrees, and only from the keys the grant names.
 *
 * The relay is not trusted here either, so what this browser signs never
 * comes from relay data alone:
 * - permissions come from the role (a fixed map), and an unfamiliar list is
 *   refused rather than signed;
 * - the owner sees role, permissions, expiry and each device's fingerprint
 *   before signing;
 * - renewal re-signs only a grant this browser verifiably signed itself,
 *   changing nothing but the expiry (and never past its signed `notAfter`);
 * - a narrowed grant gets a new id and the old one is revoked on the machine;
 * - revocations are kept here until the machine confirms them with its key.
 */

import {
  GRANT_ACTION, GRANT_REVOKED_LABEL, GRANT_REVOKE_ACTION, MAX_GRANT_LIFETIME_MS, grantNeedsStepUp, grantPayload, grantRevokePayload,
} from '../../server/relay/intent-actions'
import type { GrantBody, SignedIntent } from '../../server/relay/intent-actions'
import {
  currentUserId, defaultBrowserLabel, fromB64url, getOrCreateBrowserKey, transcript, trustStorage, verifyWith, type TrustStorage,
} from './deviceTrust'
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
  /** The stored signed grant (relay data: verified before it is trusted). */
  signedGrantRaw?: { grant: string; intent: unknown } | null
}

export interface GranteeKey {
  keyId: string
  spki: string
  label: string
  lastSeenAt: string | null
}

/** The permissions each sharing role stands for (server/relay/shares.ts SHARE_ROLES). */
export const ROLE_PERMISSIONS = {
  viewer: ['view', 'view_diff'],
  editor: ['view', 'view_diff', 'send_prompt', 'upload_file', 'approve_readonly_tool'],
} as const
export type ShareRole = keyof typeof ROLE_PERMISSIONS

/** The role a permission list is exactly, or null for anything else. */
export function roleOf(permissions: readonly string[]): ShareRole | null {
  const set = [...permissions].sort().join(',')
  for (const role of Object.keys(ROLE_PERMISSIONS) as ShareRole[]) {
    if ([...ROLE_PERMISSIONS[role]].sort().join(',') === set) return role
  }
  return null
}

/** A short fingerprint to show next to a device label (labels are free text from the relay). */
export function fingerprint(keyId: string): string {
  return keyId.slice(0, 8)
}

/** Renew a grant this long before it runs out. */
export const RENEW_WITHIN_MS = 7 * 24 * 60 * 60_000

export class GrantError extends Error {
  readonly code: 'not_confirmed' | 'no_keys' | 'rejected' | 'unknown_permissions' | 'not_mine'
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

async function sha256b64url(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
  let binary = ''
  for (const b of digest) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * The grant this browser signed for a share, if the stored one verifiably
 * is: signed by this browser's own key, for this machine and session, over
 * exactly this text. Null for anything else (including passkey-signed ones,
 * which need the owner again anyway).
 */
export async function ownSignedGrant(share: ShareWithGrant, storage: TrustStorage = trustStorage()): Promise<GrantBody | null> {
  const raw = share.signedGrantRaw
  if (!raw || typeof raw.grant !== 'string') return null
  const intent = raw.intent as Partial<SignedIntent> | null
  if (!intent || typeof intent.body !== 'string' || typeof intent.sig !== 'string') return null
  const userId = await currentUserId()
  const key = userId ? await storage.getKey(userId) : undefined
  if (!key) return null
  if (!await verifyWith(fromB64url(key.spki), new TextEncoder().encode(intent.body), fromB64url(intent.sig))) return null
  let body: { action?: unknown; machineId?: unknown; sessionId?: unknown; payloadHash?: unknown }
  let grant: GrantBody
  try {
    body = JSON.parse(intent.body) as typeof body
    grant = JSON.parse(raw.grant) as GrantBody
  } catch {
    return null
  }
  if (body.action !== GRANT_ACTION || body.machineId !== share.machineId || body.sessionId !== share.localSessionId) return null
  if (body.payloadHash !== await sha256b64url(grantPayload(raw.grant))) return null
  if (grant.sessionId !== share.localSessionId) return null
  return grant
}

/** A grant id for a new signature over a share: narrowed grants must be revocable on their own. */
function freshGrantId(shareId: string, now = Date.now()): string {
  // Time for order, randomness so two signatures in one millisecond differ.
  const random = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, '0')).join('')
  return `${shareId}:${now.toString(36)}${random}`
}

/** Expiry for a grant: 30 days, never past `notAfter`. */
function grantExpiry(notAfter: number | null, now = Date.now()): number {
  return Math.min(now + MAX_GRANT_LIFETIME_MS, notAfter ?? Infinity)
}

/** What the owner is asked to sign, shown in full before they do. */
export interface GrantProposal {
  share: ShareWithGrant
  grant: GrantBody
  role: ShareRole
  /** The grantee's devices the grant names, with labels to show. */
  devices: GranteeKey[]
  /** Devices added since the last signed grant (the "new device" case). */
  added: GranteeKey[]
  /** An earlier grant this one narrows; revoked on the machine once signed. */
  replaces: string | null
}

/**
 * Propose the grant for a share. Permissions come from the role the share's
 * list exactly matches (an unfamiliar list is refused, never signed); the
 * share's end becomes the signed `notAfter`. With an earlier grant this
 * browser signed, its devices carry over and only `newDevices` are added.
 */
export async function proposeGrant(
  share: ShareWithGrant,
  devices: GranteeKey[],
  opts: { now?: number; storage?: TrustStorage } = {},
): Promise<GrantProposal> {
  const now = opts.now ?? Date.now()
  const role = roleOf(share.permissions)
  if (!role) throw new GrantError('unknown_permissions', "This share lists permissions this page doesn't recognise. Revoke it and share again.")
  if (!share.granteeUserId) throw new GrantError('rejected', 'This share has no member to grant to')
  if (devices.length === 0) throw new GrantError('no_keys', 'They have no browser to allow yet. Ask them to open the session once, then come back here.')
  const previous = await ownSignedGrant(share, opts.storage)
  const notAfter = share.expiresAt ? Date.parse(share.expiresAt) : null
  const permissions: string[] = [...ROLE_PERMISSIONS[role]]
  const previousKeys = new Set(previous?.granteeKeys.map(k => k.keyId) ?? [])
  const added = previous ? devices.filter(d => !previousKeys.has(d.keyId)) : devices
  // A grant that drops a permission or a device must be revocable apart from the old one.
  const narrows = !!previous && (
    previous.permissions.some(p => !permissions.includes(p)) || previous.granteeKeys.some(k => !devices.some(d => d.keyId === k.keyId))
  )
  const grant: GrantBody = {
    grantId: freshGrantId(share.id, now),
    sessionId: share.localSessionId,
    granteeUserId: share.granteeUserId,
    permissions,
    granteeKeys: devices.map(d => ({ keyId: d.keyId, spki: d.spki })),
    expiresAt: grantExpiry(notAfter, now),
    notAfter,
  }
  return { share, grant, role, devices, added, replaces: narrows ? previous.grantId : null }
}

async function storeGrant(transport: GrantTransport, share: ShareWithGrant, grant: GrantBody): Promise<ShareWithGrant> {
  const text = JSON.stringify(grant)
  const intent = await transport.signIntent({
    action: GRANT_ACTION, sessionId: share.localSessionId, payload: grantPayload(text), stepUp: grantNeedsStepUp(grant.permissions),
  })
  if (!intent) throw new GrantError('not_confirmed', 'Confirm this browser on the computer first (Settings → Machines), then try again.')
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

/** Sign a proposal the owner has reviewed; revoke the grant it narrows on the machine. */
export async function signGrant(transport: GrantTransport, proposal: GrantProposal, storage: TrustStorage = trustStorage()): Promise<ShareWithGrant> {
  const stored = await storeGrant(transport, proposal.share, proposal.grant)
  if (proposal.replaces) await queueRevocations(transport, proposal.share.machineId, [proposal.replaces], storage)
  return stored
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
 * Re-sign grants that run out within a week (D3): only grants this browser
 * verifiably signed, with the same id, permissions and devices, and a new
 * expiry that never passes their signed `notAfter`. Anything else waits for
 * the owner. Returns how many were renewed.
 */
export async function renewGrants(transport: GrantTransport, machineId: string, opts: { now?: number; storage?: TrustStorage } = {}): Promise<number> {
  const now = opts.now ?? Date.now()
  const storage = opts.storage ?? trustStorage()
  const res = await fetch('/api/shares', { credentials: 'include', headers: workspaceHeaders() })
  if (!res.ok) return 0
  const shares = ((await res.json()) as { shared?: ShareWithGrant[] }).shared ?? []
  const userId = await currentUserId()
  const revoked = new Set(userId && storage.getRevocations ? await storage.getRevocations(userId, machineId) : [])
  let renewed = 0
  for (const share of shares) {
    if (share.machineId !== machineId) continue
    const previous = await ownSignedGrant(share, storage)
    if (!previous || revoked.has(previous.grantId) || previous.expiresAt - now > RENEW_WITHIN_MS) continue
    const expiresAt = grantExpiry(previous.notAfter ?? null, now)
    if (expiresAt <= previous.expiresAt) continue
    try {
      await storeGrant(transport, share, { ...previous, expiresAt })
      renewed += 1
    } catch {
      // Not confirmed here, or the relay refused: try again next time.
    }
  }
  return renewed
}

// --- Revocation ------------------------------------------------------------

/**
 * Keep these grant ids revoked until the machine confirms each with its key,
 * then try now. The share can go from the relay at once; this list makes
 * sure a relay that keeps presenting the old grant gets nowhere.
 */
export async function queueRevocations(transport: GrantTransport, machineId: string, grantIds: string[], storage: TrustStorage = trustStorage()): Promise<string[]> {
  const userId = await currentUserId()
  if (userId && storage.getRevocations && storage.putRevocations) {
    const pending = new Set(await storage.getRevocations(userId, machineId))
    for (const id of grantIds) pending.add(id)
    await storage.putRevocations(userId, machineId, [...pending])
  }
  return flushRevocations(transport, machineId, storage, grantIds)
}

/** Send pending revocations; returns the ids still waiting for the machine's confirmation. */
export async function flushRevocations(transport: GrantTransport, machineId: string, storage: TrustStorage = trustStorage(), extra: string[] = []): Promise<string[]> {
  const userId = await currentUserId()
  if (!userId) return extra
  const stored = storage.getRevocations ? await storage.getRevocations(userId, machineId) : []
  const pending = [...new Set([...stored, ...extra])]
  const pin = await storage.getPin(userId, machineId)
  const left: string[] = []
  for (const grantId of pending) {
    try {
      const intent = await transport.signIntent({ action: GRANT_REVOKE_ACTION, sessionId: null, payload: grantRevokePayload(grantId) })
      if (!intent) { left.push(grantId); continue }
      const reply = await transport.sendDeviceFrame('enrol_grant_revoke', { grantId, intent }) as { state?: unknown; signature?: unknown }
      // Only the machine's own key confirms it; the relay could fake "approved".
      const confirmed = !!pin && reply.state === 'approved' && typeof reply.signature === 'string'
        && await verifyWith(fromB64url(pin.machineKey), transcript(GRANT_REVOKED_LABEL, grantId), fromB64url(reply.signature))
      if (!confirmed) left.push(grantId)
    } catch {
      left.push(grantId)
    }
  }
  if (storage.putRevocations) await storage.putRevocations(userId, machineId, left)
  return left
}

/** Revoke a share's grants on the machine (every id it may have been signed under). */
export async function revokeShareGrants(transport: GrantTransport, share: ShareWithGrant, storage: TrustStorage = trustStorage()): Promise<string[]> {
  const ids = new Set([share.id])
  try {
    const raw = share.signedGrantRaw?.grant
    const signedId = raw ? (JSON.parse(raw) as { grantId?: unknown }).grantId : undefined
    if (typeof signedId === 'string') ids.add(signedId)
  } catch { /* the share id alone */ }
  return queueRevocations(transport, share.machineId, [...ids], storage)
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
