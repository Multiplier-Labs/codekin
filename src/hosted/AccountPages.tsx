/**
 * Hosted Settings pages about people rather than machines:
 * - ProfileSection (Account → Profile): who is signed in, and sign out;
 * - AccountsSection (Platform → Accounts, operator only): every account on
 *   the platform, its status, and who may create workspaces;
 * - AbuseReviewSection (same page): machines the relay's abuse signals flagged.
 */

import { useCallback, useEffect, useState } from 'react'
import { currentWorkspaceId } from './workspace'
import { isStepUpCancel } from './mfa'
import { Row, Rows, button, checkbox, input } from '../components/settings/Block'
import {
  fetchAbuseFlags, fetchAccounts, fetchMe, resolveAbuseFlag, signOut, updateAccount,
  type AbuseFlag, type Me, type PlatformAccount,
} from './accounts'


export function ProfileSection() {
  const [me, setMe] = useState<Me | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetchMe().then(setMe).catch(() => { setMe(null) })
  }, [])

  if (!me) return <p className="text-body text-ink-muted">Loading…</p>
  const workspace = me.workspaceNames[currentWorkspaceId() ?? '']
  return (
    <div>
      <div className="flex items-center gap-3">
        {me.avatarUrl && <img src={me.avatarUrl} alt="" className="h-12 w-12 rounded-full" />}
        <div className="min-w-0">
          <p className="truncate text-title text-ink">{me.displayName ?? me.login}</p>
          <p className="truncate font-mono text-body text-ink-muted">github.com/{me.login}</p>
        </div>
      </div>
      <div className="mt-4 border-t border-edge pt-3">
        <Rows>
          {workspace && <Row label="Workspace" control={<span className="text-body text-ink">{workspace}</span>} />}
          {me.isOperator && <Row label="Role" control={<span className="text-body text-ink">Platform operator</span>} />}
          <Row
            label="Sign out"
            description="Signs out this browser. To end every session on every device, use Security → Devices & passkeys."
            control={
              <button onClick={() => { setBusy(true); void signOut() }} disabled={busy} className={button}>
                Sign out
              </button>
            }
          />
        </Rows>
      </div>
    </div>
  )
}

const STATUS_LABEL: Record<PlatformAccount['status'], string> = { active: 'Active', pending: 'Pending', disabled: 'Disabled' }

export function AccountsSection() {
  const [accounts, setAccounts] = useState<PlatformAccount[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(() => {
    fetchAccounts().then(setAccounts).catch(() => { setError('Could not load accounts.') })
  }, [])
  useEffect(() => { reload() }, [reload])

  const change = async (account: PlatformAccount, patch: Parameters<typeof updateAccount>[1]) => {
    setBusyId(account.id)
    setError(null)
    try {
      const updated = await updateAccount(account.id, patch)
      setAccounts(list => list?.map(a => (a.id === updated.id ? updated : a)) ?? null)
    } catch (err) {
      if (!isStepUpCancel(err)) setError(err instanceof Error ? err.message : 'Could not update the account.')
    } finally {
      setBusyId(null)
    }
  }

  if (!accounts) return error ? <p className="text-meta text-error-4">{error}</p> : <p className="text-body text-ink-muted">Loading…</p>
  return (
    <div>
      <ul className="divide-y divide-edge">
        {accounts.map(account => {
          const busy = busyId === account.id
          return (
            <li key={account.id} className="flex flex-wrap items-center gap-3 py-2.5">
              <span className={`min-w-0 flex-1 truncate text-body ${account.status === 'active' ? 'text-ink' : 'text-ink-muted'}`}>
                {account.displayName ?? account.login}
                <span className="ml-1.5 font-mono text-meta text-ink-muted">{account.login}</span>
                {account.isOperator && <span className="ml-1.5 text-meta text-primary-5">operator</span>}
              </span>
              {account.isOperator ? (
                <span className="text-meta text-ink-muted">{STATUS_LABEL[account.status]}</span>
              ) : (
                <>
                  <label className="flex items-center gap-2 text-body text-ink-muted">
                    <input
                      type="checkbox"
                      className={checkbox}
                      checked={account.canCreateWorkspaces}
                      disabled={busy || account.status !== 'active'}
                      onChange={e => { void change(account, { canCreateWorkspaces: e.target.checked }) }}
                    />
                    Can create workspaces
                  </label>
                  <select
                    aria-label={`Status of ${account.login}`}
                    value={account.status}
                    disabled={busy}
                    onChange={e => {
                      const status = e.target.value as PlatformAccount['status']
                      if (status === 'disabled' && !window.confirm(`Disable ${account.login}? They are signed out everywhere.`)) return
                      void change(account, { status })
                    }}
                    className={input}
                  >
                    {(['active', 'pending', 'disabled'] as const).map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                  </select>
                </>
              )}
            </li>
          )
        })}
      </ul>
      {error && <p className="mt-2 text-meta text-error-4">{error}</p>}
    </div>
  )
}

/**
 * Open abuse flags, newest first. Resolving one needs a note of what was
 * decided. Disabling the owner is done in Accounts above, deliberately not
 * from here.
 */
export function AbuseReviewSection() {
  const [flags, setFlags] = useState<AbuseFlag[] | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(() => {
    fetchAbuseFlags().then(setFlags).catch(() => { setError('Could not load abuse flags.') })
  }, [])
  useEffect(() => { reload() }, [reload])

  const resolve = async (flag: AbuseFlag) => {
    setBusyId(flag.id)
    setError(null)
    try {
      await resolveAbuseFlag(flag.id, notes[flag.id] ?? '')
      setFlags(list => list?.filter(f => f.id !== flag.id) ?? null)
    } catch (err) {
      if (!isStepUpCancel(err)) setError(err instanceof Error ? err.message : 'Could not resolve the flag.')
    } finally {
      setBusyId(null)
    }
  }

  if (!flags) return error ? <p className="text-meta text-error-4">{error}</p> : <p className="text-body text-ink-muted">Loading…</p>
  if (flags.length === 0) return <p className="text-body text-ink-muted">Nothing to review.</p>
  return (
    <div>
      <ul className="divide-y divide-edge">
        {flags.map(flag => {
          const note = notes[flag.id] ?? ''
          return (
            <li key={flag.id} className="space-y-2 py-2.5">
              <div className="flex flex-wrap items-baseline gap-x-2 text-body text-ink">
                <span className="font-mono text-meta text-ink-muted">{flag.signal}</span>
                <span>{flag.machineName ?? flag.machineId}</span>
                {flag.ownerLogin && <span className="font-mono text-meta text-ink-muted">{flag.ownerLogin}</span>}
                {flag.action === 'throttle' && <span className="text-meta text-warning-5">throttled until resolved</span>}
                <span className="ml-auto text-meta text-ink-faint">{flag.createdAt} UTC</span>
              </div>
              <p className="font-mono text-meta text-ink-muted">
                {Object.entries(flag.detail).map(([k, v]) => `${k}=${String(v)}`).join('  ')}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  aria-label={`Decision on ${flag.signal} for ${flag.machineName ?? flag.machineId}`}
                  placeholder="What was decided (required)"
                  value={note}
                  onChange={e => { setNotes(n => ({ ...n, [flag.id]: e.target.value })) }}
                  className={`${input} min-w-0 flex-1`}
                />
                <button
                  className={button}
                  disabled={busyId === flag.id || note.trim() === ''}
                  onClick={() => { void resolve(flag) }}
                >
                  Resolve
                </button>
              </div>
            </li>
          )
        })}
      </ul>
      {error && <p className="mt-2 text-meta text-error-4">{error}</p>}
    </div>
  )
}
