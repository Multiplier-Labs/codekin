/**
 * Share one session of a machine with another signed-in user.
 *
 * Roles map to the spec's default table: a viewer watches, an editor can
 * drive the session but still cannot approve mutating tools or shell
 * commands — those stay with the owner unless granted deliberately.
 */

import { useState, useEffect, useCallback } from 'react'

export interface SessionShare {
  id: string
  machineId: string
  localSessionId: string
  granteeUserId: string | null
  permissions: string[]
  createdAt: string
  expiresAt: string | null
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
  const [login, setLogin] = useState('')
  const [role, setRole] = useState<'viewer' | 'editor'>('viewer')
  const [shares, setShares] = useState<SessionShare[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadShares = useCallback(async () => {
    try {
      const res = await fetch('/api/shares', { credentials: 'include' })
      if (!res.ok) return
      const data = (await res.json()) as { shared?: SessionShare[] }
      setShares((data.shared ?? []).filter(s => s.machineId === machineId && s.localSessionId === sessionId))
    } catch {
      // Listing is best-effort; the form still works
    }
  }, [machineId, sessionId])

  useEffect(() => { void loadShares() }, [loadShares])

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/shares', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machineId, localSessionId: sessionId, granteeLogin: login.trim(), role }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? `Request failed (${res.status})`)
      }
      setLogin('')
      await loadShares()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (shareId: string) => {
    await fetch(`/api/shares/${shareId}`, { method: 'DELETE', credentials: 'include' })
    await loadShares()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-page/80 p-4">
      <div className="w-full max-w-md rounded-floating border border-edge-strong bg-surface-raised p-6 shadow-floating">
        <h2 className="mb-1 text-title text-ink">Share session</h2>
        <p className="mb-4 truncate text-meta text-ink-muted">{sessionName}</p>

        <label className="mb-1 block text-meta text-ink-muted" htmlFor="share-login">
          GitHub login
        </label>
        <input
          id="share-login"
          value={login}
          onChange={e => { setLogin(e.target.value) }}
          placeholder="octocat"
          className="mb-3 w-full rounded-control border border-edge bg-surface px-3 py-2 text-body text-ink focus:border-focus focus:outline-none"
        />

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
                <li
                  key={share.id}
                  className="flex items-center gap-2 rounded-control border border-edge bg-surface px-3 py-1.5"
                >
                  <span className="truncate text-meta text-ink">
                    {share.permissions.includes('send_prompt') ? 'Editor' : 'Viewer'}
                  </span>
                  <button
                    onClick={() => void revoke(share.id)}
                    className="ml-auto text-meta text-ink-muted transition hover:text-error-7"
                  >
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
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
            disabled={busy || login.trim().length === 0}
            className="rounded-control bg-primary-6 px-3 py-1.5 text-meta text-ink-inverse transition hover:bg-primary-7 disabled:opacity-50"
          >
            {busy ? 'Sharing…' : 'Share'}
          </button>
        </div>
      </div>
    </div>
  )
}
