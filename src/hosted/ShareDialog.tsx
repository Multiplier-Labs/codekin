/**
 * Share one session of a machine with another signed-in user.
 *
 * Roles map to the spec's default table: a viewer watches, an editor can
 * drive the session but still cannot approve mutating tools or shell
 * commands — those stay with the owner unless granted deliberately.
 */

import { useState, useEffect, useCallback } from 'react'
import { currentWorkspaceId, fetchMembers, workspaceHeaders, type WorkspaceMember } from './workspace'
import {
  fetchGranteeKeys, fingerprint, flushRevocations, grantStatus, proposeGrant, recordShare, revokeShareGrants, signGrant,
  type GrantProposal, type GrantStatus, type GrantTransport, type ShareWithGrant,
} from './grants'
import { transport } from '../lib/transport'

export interface SessionShare extends ShareWithGrant {
  createdAt: string
}

/** The hosted transport signs grants; the local one never renders this dialog. */
function grantTransport(): GrantTransport | null {
  const t = transport as unknown as Partial<GrantTransport>
  return typeof t.signIntent === 'function' && typeof t.sendDeviceFrame === 'function' ? t as GrantTransport : null
}

/** One share: who, which role, and whether the owner's grant covers their devices (§6.7). */
function ShareRow({ share, login, status, busy, onAllow, onRevoke }: {
  share: SessionShare
  login: string
  status: GrantStatus | undefined
  busy: boolean
  onAllow: (status: GrantStatus) => void
  onRevoke: () => void
}) {
  // Something to sign: never signed, or a device the grant doesn't name, and devices to name.
  const toAllow = status && status.kind !== 'signed' && status.keys.length > 0 ? status : null
  return (
    <li className="flex items-center gap-2 rounded-control border border-edge bg-surface px-3 py-1.5">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-meta text-ink">
          {login} · {share.permissions.includes('send_prompt') ? 'Editor' : 'Viewer'}
        </span>
        {status && (
          <span className={`block truncate text-micro ${status.kind === 'signed' ? 'text-ink-faint' : 'text-warning-5'}`}>
            {status.kind === 'new_device' ? 'New device: ' : ''}
            {describeDevices(status)}
          </span>
        )}
      </span>
      {toAllow && (
        <button onClick={() => { onAllow(toAllow) }} disabled={busy} className="text-meta text-primary-5 transition hover:underline disabled:opacity-50">
          Allow
        </button>
      )}
      <button onClick={onRevoke} className="ml-auto text-meta text-ink-muted transition hover:text-error-7">
        Revoke
      </button>
    </li>
  )
}

function describeDevices(status: GrantStatus): string {
  if (status.kind === 'signed') return `Allowed on ${status.keyIds.length} device${status.keyIds.length === 1 ? '' : 's'}`
  // For a new device, name only what is new, with fingerprints (labels are free text).
  const keys = status.kind === 'new_device' ? status.added : status.keys
  if (keys.length === 0) return 'No device yet'
  return `${keys.length} device${keys.length === 1 ? '' : 's'}: ${keys.map(k => `${k.label} (${fingerprint(k.keyId)})`).join(', ')}`
}

const ROLE_OPTIONS = [
  { value: 'viewer', label: 'Viewer', hint: 'Watch the session and its diffs' },
  { value: 'editor', label: 'Editor', hint: 'Also send prompts, upload files, approve read-only tools' },
] as const

interface ShareDialogProps {
  machineId: string
  sessionId: string
  sessionName: string
  onClose: () => void
}

export function ShareDialog({ machineId, sessionId, sessionName, onClose }: ShareDialogProps) {
  const [granteeId, setGranteeId] = useState('')
  const [members, setMembers] = useState<WorkspaceMember[] | null>(null)
  const [role, setRole] = useState<'viewer' | 'editor'>('viewer')
  const [shares, setShares] = useState<SessionShare[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Each share's grant against the grantee's current devices (§6.7). */
  const [grants, setGrants] = useState<Partial<Record<string, GrantStatus>>>({})
  /** A grant the owner is reviewing before signing. */
  const [review, setReview] = useState<GrantProposal | null>(null)
  /** Revocations the computer hasn't confirmed yet. */
  const [pendingRevocations, setPendingRevocations] = useState(0)

  const loadShares = useCallback(async () => {
    try {
      const res = await fetch('/api/shares', { credentials: 'include', headers: workspaceHeaders() })
      if (!res.ok) return
      const data = (await res.json()) as { shared?: SessionShare[] }
      const mine = (data.shared ?? []).filter(s => s.machineId === machineId && s.localSessionId === sessionId)
      setShares(mine)
      const statuses = await Promise.all(mine.map(async share => [share.id, grantStatus(share, await fetchGranteeKeys(share.id))] as const))
      setGrants(Object.fromEntries(statuses))
    } catch {
      // Listing is best-effort; the form still works
    }
  }, [machineId, sessionId])

  useEffect(() => { void loadShares() }, [loadShares])

  // Sessions are shared with members of this workspace, picked from a list
  // rather than typed, so a grant can only reach someone already inside.
  useEffect(() => {
    const workspaceId = currentWorkspaceId()
    if (!workspaceId) return
    void Promise.all([
      fetchMembers(workspaceId),
      fetch('/api/me', { credentials: 'include' }).then(res => res.json() as Promise<{ user: { id: string } | null }>),
    ])
      .then(([list, me]) => { setMembers(list.filter(m => m.userId !== me.user?.id)) })
      .catch(() => { setMembers([]) })
  }, [])

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/shares', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machineId, localSessionId: sessionId, granteeUserId: granteeId, role }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null
        // Quota refusals carry a sentence in `message`; other errors only a code or text in `error`.
        throw new Error(body?.message ?? body?.error ?? `Request failed (${res.status})`)
      }
      // Remember what the owner chose: Allow signs this, whatever the relay lists later.
      const created = (await res.json().catch(() => null)) as { share?: { id?: string } } | null
      if (created?.share?.id) {
        await recordShare(machineId, { shareId: created.share.id, sessionId, granteeUserId: granteeId, role, notAfter: null }).catch(() => {})
      }
      setGranteeId('')
      await loadShares()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (share: SessionShare) => {
    await fetch(`/api/shares/${share.id}`, { method: 'DELETE', credentials: 'include' })
    // The machine keeps its own list, so a relay can't keep presenting the old
    // grant; this browser retries until the machine confirms it.
    const t = grantTransport()
    if (t) setPendingRevocations((await revokeShareGrants(t, share).catch(() => ['?'])).length)
    await loadShares()
  }

  const retryRevocations = async () => {
    const t = grantTransport()
    if (t) setPendingRevocations((await flushRevocations(t, machineId).catch(() => ['?'])).length)
  }

  useEffect(() => { void retryRevocations() }, [machineId]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Work out the grant for the devices shown, for the owner to review. */
  const allow = async (share: SessionShare, status: GrantStatus) => {
    if (status.kind === 'signed') return
    setError(null)
    try {
      setReview(await proposeGrant(share, status.keys))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  /** Sign exactly what the owner reviewed. */
  const sign = async () => {
    const t = grantTransport()
    if (!t || !review) return
    setBusy(true)
    setError(null)
    try {
      await signGrant(t, review)
      setReview(null)
      await loadShares()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-page/80 p-4">
      <div className="w-full max-w-md rounded-floating border border-edge-strong bg-surface-raised p-6 shadow-floating">
        <h2 className="mb-1 text-title text-ink">Share session</h2>
        <p className="mb-4 truncate text-meta text-ink-muted">{sessionName}</p>

        <label className="mb-1 block text-meta text-ink-muted" htmlFor="share-member">
          Workspace member
        </label>
        <select
          id="share-member"
          value={granteeId}
          onChange={e => { setGranteeId(e.target.value) }}
          className="mb-1 w-full rounded-control border border-edge bg-surface px-3 py-2 text-body text-ink focus:border-focus focus:outline-none"
        >
          <option value="">{members === null ? 'Loading members…' : 'Choose a member'}</option>
          {(members ?? [])
            .filter(m => m.status === 'active' && m.accountStatus === 'active')
            .map(m => (
              <option key={m.userId} value={m.userId}>
                {m.displayName ? `${m.displayName} (${m.login})` : m.login}
                {m.role === 'viewer' ? ' — viewer' : ''}
              </option>
            ))}
        </select>
        <p className="mb-3 text-micro text-ink-faint">Viewers can only be given view access.</p>

        <fieldset className="mb-4 flex flex-col gap-2">
          <legend className="mb-1 text-meta text-ink-muted">Access</legend>
          {ROLE_OPTIONS.map(option => (
            <label
              key={option.value}
              className="flex cursor-pointer items-start gap-2 rounded-control border border-edge bg-surface px-3 py-2"
            >
              <input
                type="radio"
                name="share-role"
                value={option.value}
                checked={role === option.value}
                onChange={() => { setRole(option.value) }}
                className="mt-1"
              />
              <span>
                <span className="block text-body text-ink">{option.label}</span>
                <span className="block text-meta text-ink-faint">{option.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {error && <p className="mb-3 text-meta text-error-7">{error}</p>}

        {shares.length > 0 && (
          <div className="mb-4">
            <p className="mb-1 text-meta text-ink-muted">Already shared with</p>
            <ul className="flex flex-col gap-1">
              {shares.map(share => (
                <ShareRow
                  key={share.id}
                  share={share}
                  login={members?.find(m => m.userId === share.granteeUserId)?.login ?? 'Member'}
                  status={grants[share.id]}
                  busy={busy}
                  onAllow={status => void allow(share, status)}
                  onRevoke={() => void revoke(share)}
                />
              ))}
            </ul>
          </div>
        )}

        {review && (
          <div className="mb-4 rounded-control border border-edge-strong bg-surface px-3 py-2" role="region" aria-label="Review grant">
            <p className="text-meta text-ink">
              Let <span className="font-medium">{members?.find(m => m.userId === review.grant.granteeUserId)?.login ?? 'this member'}</span> act as{' '}
              <span className="font-medium">{review.role === 'editor' ? 'Editor' : 'Viewer'}</span> on this session:
            </p>
            {!review.recorded && (
              <p className="mt-1 text-micro text-warning-5">
                This browser has no record of making this share. Check the member and access before you sign.
              </p>
            )}
            {review.duplicateOf && (
              <p className="mt-1 text-micro text-warning-5">
                You already shared this session with them in another share. Signing this one adds a second grant.
              </p>
            )}
            <p className="mt-1 text-micro text-ink-muted">{review.grant.permissions.join(', ')}</p>
            <p className="mt-1 text-micro text-ink-muted">
              {review.grant.notAfter
                ? `Until ${new Date(review.grant.notAfter).toLocaleDateString()}, renewed while you are online.`
                : 'For 30 days at a time, renewed while you are online.'}
            </p>
            <p className="mt-2 text-micro text-ink-muted">{review.added.length < review.devices.length ? 'New device:' : 'Their devices:'}</p>
            <ul className="mt-1 space-y-0.5">
              {(review.added.length < review.devices.length ? review.added : review.devices).map(d => (
                <li key={d.keyId} className="text-micro text-ink">
                  {d.label} <span className="font-mono text-ink-faint">{fingerprint(d.keyId)}</span>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex justify-end gap-2">
              <button onClick={() => { setReview(null) }} className="text-meta text-ink-muted hover:text-ink">Cancel</button>
              <button onClick={() => void sign()} disabled={busy} className="rounded-control bg-primary-6 px-3 py-1 text-meta text-ink-inverse hover:bg-primary-7 disabled:opacity-50">
                {busy ? 'Signing…' : 'Sign'}
              </button>
            </div>
          </div>
        )}

        {pendingRevocations > 0 && (
          <div className="mb-4 flex items-center gap-2 text-meta text-warning-5">
            <span className="flex-1">Revocation not yet confirmed by the computer ({pendingRevocations}).</span>
            <button onClick={() => void retryRevocations()} className="text-primary-5 hover:underline">Retry</button>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-control border border-edge px-3 py-1.5 text-meta text-ink-muted transition hover:text-ink"
          >
            Close
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy || !granteeId}
            className="rounded-control bg-primary-6 px-3 py-1.5 text-meta text-ink-inverse transition hover:bg-primary-7 disabled:opacity-50"
          >
            {busy ? 'Sharing…' : 'Share'}
          </button>
        </div>
      </div>
    </div>
  )
}
