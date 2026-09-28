/**
 * Hosted Settings pages about people rather than machines:
 * - ProfileSection (Account → Profile): who is signed in, and sign out;
 * - AccountsSection (Platform → Accounts, operator only): every account on
 *   the platform, its status, and who may create workspaces.
 */

import { useCallback, useEffect, useState } from 'react'
import { currentWorkspaceId } from './workspace'
import { isStepUpCancel } from './mfa'
import { Row, Rows, button, checkbox, input } from '../components/settings/Block'
import { fetchAccounts, fetchMe, signOut, updateAccount, type Me, type PlatformAccount } from './accounts'


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
