/**
 * Hosted Settings pages about people rather than machines:
 * - ProfileSection (Account → Profile): who is signed in, and sign out;
 * - AccountsSection (Platform → Accounts, operator only): every account on
 *   the platform, its status, and who may create workspaces.
 */

import { useCallback, useEffect, useState } from 'react'
import { currentWorkspaceId } from './workspace'
import { isStepUpCancel } from './mfa'
import { fetchAccounts, fetchMe, signOut, updateAccount, type Me, type PlatformAccount } from './accounts'

const button =
  'rounded-control border border-edge px-3 py-1.5 text-meta text-ink-muted transition hover:bg-surface-raised hover:text-ink disabled:opacity-50'

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
          <p className="truncate font-mono text-meta text-ink-muted">github.com/{me.login}</p>
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-meta">
        {workspace && (
          <>
            <dt className="text-ink-faint">Workspace</dt>
            <dd className="text-ink">{workspace}</dd>
          </>
        )}
        {me.isOperator && (
          <>
            <dt className="text-ink-faint">Role</dt>
            <dd className="text-ink">Platform operator</dd>
          </>
        )}
      </dl>
      <div className="mt-5 border-t border-edge pt-4">
        <button onClick={() => { setBusy(true); void signOut() }} disabled={busy} className={button}>
          Sign out
        </button>
        <p className="mt-1.5 text-micro text-ink-faint">To end every session on every device, use Security → Devices & passkeys.</p>
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
      <p className="mb-3 text-meta text-ink-muted">
        Disabling an account signs it out everywhere and blocks it in every workspace. Workspace membership is managed
        by each workspace&apos;s owners and admins.
      </p>
      <ul className="divide-y divide-edge">
        {accounts.map(account => {
          const busy = busyId === account.id
          return (
            <li key={account.id} className="flex flex-wrap items-center gap-3 py-2">
              <span className={`min-w-0 flex-1 truncate text-body ${account.status === 'active' ? 'text-ink' : 'text-ink-faint'}`}>
                {account.displayName ?? account.login}
                <span className="ml-1.5 font-mono text-meta text-ink-faint">{account.login}</span>
                {account.isOperator && <span className="ml-1.5 text-micro text-primary-5">operator</span>}
              </span>
              {account.isOperator ? (
                <span className="text-meta text-ink-muted">{STATUS_LABEL[account.status]}</span>
              ) : (
                <>
                  <label className="flex items-center gap-1.5 text-meta text-ink-muted">
                    <input
                      type="checkbox"
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
                    className="rounded-control border border-edge bg-surface px-2 py-1 text-meta text-ink focus:border-focus focus:outline-none"
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
