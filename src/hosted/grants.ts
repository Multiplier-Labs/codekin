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
 * - what the owner chose (role, end) and every grant this browser issued are
 *   kept here (IndexedDB), and renewal and revocation work from that record;
 * - renewal re-signs only a share's current grant, changing nothing but the
 *   expiry (never past its signed `notAfter`);
 * - every new signature revokes the one it supersedes, and revoking a share
 *   revokes its id, which the machine applies to all its grants;
 * - revocations are kept here until the machine confirms them with its key.
 */

import {
  GRANT_ACTION, GRANT_REVOKED_LABEL, GRANT_REVOKE_ACTION, MAX_GRANT_LIFETIME_MS, grantNeedsStepUp, grantPayload, grantRevokePayload,
} from '../../server/relay/intent-actions'
import type { GrantBody, SignedIntent } from '../../server/relay/intent-actions'
import {
  currentUserId, defaultBrowserLabel, fromB64url, getOrCreateBrowserKey, transcript, trustStorage, verifyWith,
  type IssuedGrant, type TrustStorage,
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
  readonly code: 'not_confirmed' | 'no_keys' | 'rejected' | 'unknown_permissions' | 'gone'
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

// --- The owner's own record ----------------------------------------------------

interface Ledger {
  userId: string
  entries: IssuedGrant[]
  save: () => Promise<void>
}

/** This browser's record of the grants it issued on a machine (never the relay's listing). */
async function loadLedger(machineId: string, storage: TrustStorage): Promise<Ledger | null> {
  const userId = await currentUserId()
  if (!userId || !storage.getIssuedGrants || !storage.putIssuedGrants) return null
  let entries: IssuedGrant[]
  try {
    entries = await storage.getIssuedGrants(userId, machineId)
  } catch {
    // No usable storage (private browsing): no record, so nothing renews silently.
    return null
  }
  const put = storage.putIssuedGrants.bind(storage)
  return { userId, entries, save: () => put(userId, machineId, entries) }
}

function entryFor(ledger: Ledger, shareId: string): IssuedGrant | undefined {
  return ledger.entries.find(e => e.shareId === shareId)
}

/**
 * Remember what the owner chose when sharing: the role and the share's end.
 * Allow later signs exactly this, whatever the relay lists by then.
 */
export async function recordShare(machineId: string, shareId: string, role: ShareRole, notAfter: number | null, storage: TrustStorage = trustStorage()): Promise<void> {
  const ledger = await loadLedger(machineId, storage)
  if (!ledger || entryFor(ledger, shareId)) return
  ledger.entries.push({ shareId, role, notAfter, current: null, issuedIds: [], revoked: false })
  await ledger.save()
}

function parseGrantText(text: string | undefined): GrantBody | null {
  if (!text) return null
  try { return JSON.parse(text) as GrantBody } catch { return null }
}

/** A grant id for a new signature over a share; the machine revokes `<share>` and every `<share>:…` together. */
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
  /** Devices added since this browser last signed for the share (the "new device" case). */
  added: GranteeKey[]
  /** The grant this one supersedes; revoked on the machine once this is signed. */
  replaces: string | null
}

/**
 * Propose the grant for a share. Role and end come from what the owner chose
 * in this browser (recordShare); only a share made elsewhere falls back to
 * the relay's listing, which must then match a role exactly and is shown in
 * full for review.
 */
export async function proposeGrant(
  share: ShareWithGrant,
  devices: GranteeKey[],
  opts: { now?: number; storage?: TrustStorage } = {},
): Promise<GrantProposal> {
  const now = opts.now ?? Date.now()
  const storage = opts.storage ?? trustStorage()
  const ledger = await loadLedger(share.machineId, storage)
  const entry = ledger ? entryFor(ledger, share.id) : undefined
  if (entry?.revoked) throw new GrantError('rejected', 'This share was revoked.')
  const role = entry?.role ?? roleOf(share.permissions)
  if (!role) throw new GrantError('unknown_permissions', "This share lists permissions this page doesn't recognise. Revoke it and share again.")
  if (!share.granteeUserId) throw new GrantError('rejected', 'This share has no member to grant to')
  if (devices.length === 0) throw new GrantError('no_keys', 'They have no browser to allow yet. Ask them to open the session once, then come back here.')
  const notAfter = entry ? entry.notAfter : share.expiresAt ? Date.parse(share.expiresAt) : null
  const previous = parseGrantText(entry?.current?.grant)
  const previousKeys = new Set(previous?.granteeKeys.map(k => k.keyId) ?? [])
  const grant: GrantBody = {
    grantId: freshGrantId(share.id, now),
    sessionId: share.localSessionId,
    granteeUserId: share.granteeUserId,
    permissions: [...ROLE_PERMISSIONS[role]],
    granteeKeys: devices.map(d => ({ keyId: d.keyId, spki: d.spki })),
    expiresAt: grantExpiry(notAfter, now),
    notAfter,
  }
  return {
    share, grant, role, devices,
    added: previous ? devices.filter(d => !previousKeys.has(d.keyId)) : devices,
    replaces: entry?.current?.grantId ?? null,
  }
}

async function storeGrant(transport: GrantTransport, share: Pick<ShareWithGrant, 'id' | 'localSessionId'>, grant: GrantBody): Promise<string> {
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
    throw new GrantError(res.status === 404 || res.status === 403 ? 'gone' : 'rejected', body?.error ?? `Could not store the grant (${res.status})`)
  }
  return text
}

/** Sign a proposal the owner has reviewed, record it, and revoke the grant it supersedes. */
export async function signGrant(transport: GrantTransport, proposal: GrantProposal, storage: TrustStorage = trustStorage()): Promise<void> {
  const text = await storeGrant(transport, proposal.share, proposal.grant)
  const ledger = await loadLedger(proposal.share.machineId, storage)
  if (ledger) {
    let entry = entryFor(ledger, proposal.share.id)
    if (!entry) {
      entry = { shareId: proposal.share.id, role: proposal.role, notAfter: proposal.grant.notAfter ?? null, current: null, issuedIds: [], revoked: false }
      ledger.entries.push(entry)
    }
    entry.current = { grantId: proposal.grant.grantId, grant: text }
    entry.issuedIds = [...entry.issuedIds, proposal.grant.grantId]
    await ledger.save()
  }
  // Superseded grants are revoked whether they were broader or not.
  if (proposal.replaces) await queueRevocations(transport, proposal.share.machineId, [proposal.replaces], storage)
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
 * Re-sign grants that run out within a week (D3), from this browser's own
 * record only: the current grant of each share it hasn't revoked, same id,
 * permissions and devices, a new expiry never past its signed `notAfter`.
 * The relay's listing plays no part. A share the relay no longer has is
 * revoked here and on the machine. Returns how many were renewed.
 */
export async function renewGrants(transport: GrantTransport, machineId: string, opts: { now?: number; storage?: TrustStorage } = {}): Promise<number> {
  const now = opts.now ?? Date.now()
  const storage = opts.storage ?? trustStorage()
  const ledger = await loadLedger(machineId, storage)
  if (!ledger) return 0
  let renewed = 0
  for (const entry of ledger.entries) {
    if (entry.revoked || !entry.current) continue
    let grant: GrantBody
    try { grant = JSON.parse(entry.current.grant) as GrantBody } catch { continue }
    if (grant.expiresAt - now > RENEW_WITHIN_MS) continue
    const expiresAt = grantExpiry(entry.notAfter, now)
    if (expiresAt <= grant.expiresAt) continue
    try {
      const text = await storeGrant(transport, { id: entry.shareId, localSessionId: grant.sessionId }, { ...grant, expiresAt })
      entry.current = { grantId: grant.grantId, grant: text }
      renewed += 1
    } catch (err) {
      if (err instanceof GrantError && err.code === 'gone') {
        entry.revoked = true
        await queueRevocations(transport, machineId, [entry.shareId], storage)
      }
      // Otherwise (not confirmed here, relay error): try again next time.
    }
  }
  await ledger.save()
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

/**
 * Revoke a share on the machine: its id, which covers every grant signed for
 * it (`<share>:…`), whatever the relay lists. Recorded here for good, so it
 * is never renewed or re-signed.
 */
export async function revokeShareGrants(transport: GrantTransport, share: Pick<ShareWithGrant, 'id' | 'machineId'>, storage: TrustStorage = trustStorage()): Promise<string[]> {
  const ledger = await loadLedger(share.machineId, storage)
  if (ledger) {
    const entry = entryFor(ledger, share.id)
    if (entry) entry.revoked = true
    else ledger.entries.push({ shareId: share.id, role: 'viewer', notAfter: null, current: null, issuedIds: [], revoked: true })
    await ledger.save()
  }
  return queueRevocations(transport, share.machineId, [share.id], storage)
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
