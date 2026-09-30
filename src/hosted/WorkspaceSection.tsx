/**
 * Workspace, as a section of Settings (hosted only): which workspace this tab
 * is in, who is in it, and — for owners and admins — every machine in it.
 *
 * Self-contained: it reads the account from /api/me and the workspace from
 * this tab's choice (./workspace), so Settings only has to place it. Every
 * control is gated on the caller's role for tidiness; the relay enforces it.
 * Lazy-loaded by Settings so the local build never pulls it in.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  BOOTSTRAP_WORKSPACE_ID,
  ROLE_LABELS,
  can,
  canManageMember,
  createInvitation,
  createWorkspace,
  currentWorkspaceId,
  fetchInvitations,
  resendInvitation,
  revokeInvitation,
  deleteWorkspace,
  fetchMembers,
  fetchWorkspaceMachines,
  removeMember,
  removeWorkspaceMachine,
  renameWorkspace,
  setWorkspaceRequireMfa,
  switchWorkspace,
  transferMachine,
  updateMember,
  type InvitableRole,
  type PendingInvitation,
  type Workspace,
  type WorkspaceMachine,
  type WorkspaceMember,
  type WorkspaceRole,
} from './workspace'
import { isStepUpCancel } from './mfa'
import { Block, Row, Rows, button, checkbox, dangerButton, input, quietButton } from '../components/settings/Block'

interface Account {
  userId: string
  workspaces: Workspace[]
  canCreateWorkspaces: boolean
}

const subheading = 'mb-2 text-body font-semibold text-ink'

function errorText(err: unknown): string | null {
  // Dismissing the "confirm it's you" prompt is a choice, not an error.
  if (isStepUpCancel(err)) return null
  return err instanceof Error ? err.message : 'Something went wrong. Try again.'
}

/** Create a workspace and move into it. */
export function CreateWorkspaceForm({ onCancel }: { onCancel?: () => void }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const workspace = await createWorkspace(name.trim())
      await switchWorkspace(workspace.id)
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={e => { e.preventDefault(); void submit() }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="Workspace name"
          value={name}
          onChange={e => { setName(e.target.value) }}
          placeholder="Workspace name"
          maxLength={64}
          className={`${input} min-w-0 flex-1`}
        />
        <button type="submit" disabled={busy || !name.trim()} className={button}>
          {busy ? 'Creating…' : 'Create'}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className={quietButton}>
            Cancel
          </button>
        )}
      </div>
      {error && <p className="text-meta text-error-4">{error}</p>}
    </form>
  )
}

function MemberRow({
  member,
  actorRole,
  isSelf,
  onChanged,
  onError,
}: {
  member: WorkspaceMember
  actorRole: WorkspaceRole
  isSelf: boolean
  onChanged: () => void
  onError: (message: string | null) => void
}) {
  const workspaceId = currentWorkspaceId() ?? ''
  const [busy, setBusy] = useState(false)
  const manageable = !isSelf && canManageMember(actorRole, member.role)
  const roleOptions = (['owner', 'admin', 'member', 'viewer'] as WorkspaceRole[]).filter(
    role => role === member.role || canManageMember(actorRole, member.role, role),
  )

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    onError(null)
    try {
      await action()
      onChanged()
    } catch (err) {
      onError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const name = member.displayName ?? member.login
  const inactive = member.status === 'suspended' || member.accountStatus !== 'active'

  return (
    <li className="flex flex-wrap items-center gap-2 py-2.5">
      <span className={`min-w-0 flex-1 truncate text-body ${inactive ? 'text-ink-faint' : 'text-ink'}`}>
        {name}
        {name !== member.login && <span className="ml-1.5 font-mono text-meta text-ink-muted">{member.login}</span>}
        {isSelf && <span className="ml-1.5 text-meta text-ink-muted">(you)</span>}
        {member.status === 'suspended' && <span className="ml-1.5 text-meta text-warning-5">suspended</span>}
        {member.accountStatus === 'disabled' && <span className="ml-1.5 text-meta text-error-4">account disabled</span>}
        <span className={`ml-1.5 text-meta ${member.mfaEnabled ? 'text-success-6' : 'text-ink-muted'}`}>
          {member.mfaEnabled ? '2FA' : 'no 2FA'}
        </span>
      </span>
      {manageable ? (
        <>
          <select
            aria-label={`Role for ${member.login}`}
            value={member.role}
            disabled={busy}
            onChange={e => {
              const role = e.target.value as WorkspaceRole
              void run(() => updateMember(workspaceId, member.userId, { role }))
            }}
            className={input}
          >
            {roleOptions.map(role => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}
          </select>
          <button
            disabled={busy}
            onClick={() => {
              const status = member.status === 'suspended' ? 'active' : 'suspended'
              void run(() => updateMember(workspaceId, member.userId, { status }))
            }}
            className={button}
          >
            {member.status === 'suspended' ? 'Reinstate' : 'Suspend'}
          </button>
          <button
            disabled={busy}
            onClick={() => {
              if (!window.confirm(`Remove ${member.login} from this workspace? Their machines here are locked until an admin transfers or removes them.`)) return
              void run(() => removeMember(workspaceId, member.userId))
            }}
            className={`${button} hover:text-error-4`}
          >
            Remove
          </button>
        </>
      ) : (
        <span className="text-meta text-ink-muted">{ROLE_LABELS[member.role]}</span>
      )}
    </li>
  )
}

/** A just-issued link: shown once, since the relay keeps only its hash. */
function IssuedLink({ url, onDone }: { url: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="mt-3 rounded-control border border-edge bg-page px-3 py-2.5">
      <p className="text-body text-ink-muted">Send this link to them. It works once, for them only, and is shown only now.</p>
      <div className="mt-2 flex items-center gap-2">
        <input readOnly value={url} aria-label="Invitation link" className={`${input} min-w-0 flex-1 font-mono text-meta`} onFocus={e => { e.target.select() }} />
        <button
          onClick={() => { void navigator.clipboard.writeText(url).then(() => { setCopied(true) }) }}
          className={button}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button onClick={onDone} className={quietButton}>Done</button>
      </div>
    </div>
  )
}

function InvitationsPanel({ actorRole }: { actorRole: WorkspaceRole }) {
  const workspaceId = currentWorkspaceId() ?? ''
  const [recipient, setRecipient] = useState('')
  const [role, setRole] = useState<InvitableRole>('member')
  const [pending, setPending] = useState<PendingInvitation[]>([])
  const [issued, setIssued] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const roles: InvitableRole[] = can(actorRole, 'member.manage_privileged') ? ['admin', 'member', 'viewer'] : ['member', 'viewer']

  const reload = useCallback(async () => {
    try {
      setPending(await fetchInvitations(workspaceId))
    } catch (err) {
      setError(errorText(err))
    }
  }, [workspaceId])

  useEffect(() => {
    fetchInvitations(workspaceId)
      .then(setPending)
      .catch((err: unknown) => { setError(errorText(err)) })
  }, [workspaceId])

  const run = async (action: () => Promise<string | undefined>) => {
    setBusy(true)
    setError(null)
    try {
      const url = await action()
      if (url) setIssued(url)
      await reload()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const invite = () => {
    const value = recipient.trim()
    const target = value.includes('@') && !value.startsWith('@') ? { email: value } : { githubLogin: value }
    void run(async () => {
      const result = await createInvitation(workspaceId, { role, ...target })
      setRecipient('')
      return result.inviteUrl
    })
  }

  return (
    <div className="mt-4 border-t border-edge pt-4">
      <h4 className={subheading}>Invite people</h4>
      <form className="flex flex-wrap items-center gap-2" onSubmit={e => { e.preventDefault(); invite() }}>
        <input
          aria-label="GitHub username or email"
          value={recipient}
          onChange={e => { setRecipient(e.target.value) }}
          placeholder="GitHub username or email"
          className={`${input} min-w-0 flex-1`}
        />
        <select aria-label="Role for the invitation" value={role} onChange={e => { setRole(e.target.value as InvitableRole) }} className={input}>
          {roles.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
        </select>
        <button type="submit" disabled={busy || !recipient.trim()} className={button}>
          {busy ? 'Inviting…' : 'Create link'}
        </button>
      </form>
      <p className="mt-2 text-meta text-ink-muted">
        A link for a GitHub username works only for that account; one for an email works for whoever has that
        address verified on GitHub. Links expire after 7 days.
      </p>
      {issued && <IssuedLink url={issued} onDone={() => { setIssued(null) }} />}
      {pending.length > 0 && (
        <ul className="mt-3 divide-y divide-edge">
          {pending.map(inv => (
            <li key={inv.id} className="flex flex-wrap items-center gap-2 py-2.5">
              <span className="min-w-0 flex-1 truncate text-body text-ink">
                {inv.githubLogin ?? inv.email}
                <span className="ml-1.5 text-meta text-ink-muted">
                  {ROLE_LABELS[inv.role]} · expires {new Date(inv.expiresAt).toLocaleDateString()}
                </span>
              </span>
              {(inv.role !== 'admin' || can(actorRole, 'member.manage_privileged')) && (
                <>
                  <button
                    disabled={busy}
                    onClick={() => { void run(async () => (await resendInvitation(workspaceId, inv.id)).inviteUrl) }}
                    className={button}
                  >
                    New link
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => { void run(async () => { await revokeInvitation(workspaceId, inv.id); return undefined }) }}
                    className={`${button} hover:text-error-4`}
                  >
                    Revoke
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-2 text-meta text-error-4">{error}</p>}
    </div>
  )
}

function MachineOversight({ members }: { members: WorkspaceMember[] }) {
  const workspaceId = currentWorkspaceId() ?? ''
  const [machines, setMachines] = useState<WorkspaceMachine[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const eligibleOwners = members.filter(m => m.status === 'active' && m.accountStatus === 'active' && m.role !== 'viewer')

  const load = useCallback(async () => {
    try {
      setMachines(await fetchWorkspaceMachines(workspaceId))
    } catch (err) {
      setError(errorText(err))
    }
  }, [workspaceId])

  useEffect(() => {
    fetchWorkspaceMachines(workspaceId)
      .then(setMachines)
      .catch((err: unknown) => { setError(errorText(err)) })
  }, [workspaceId])

  const run = async (action: () => Promise<void>) => {
    setError(null)
    try {
      await action()
      await load()
    } catch (err) {
      setError(errorText(err))
    }
  }

  if (machines === null) return error ? <p className="text-meta text-error-4">{error}</p> : null

  return (
    <Block
      title="All machines in this workspace"
      description="Admins see and manage every machine here but can only open sessions shared with them."
    >
      {machines.length === 0 ? (
        <p className="text-body text-ink-muted">No machines yet.</p>
      ) : (
        <ul className="divide-y divide-edge">
          {machines.map(machine => (
            <li key={machine.id} className="flex flex-wrap items-center gap-2 py-2.5">
              <span className="min-w-0 flex-1 truncate text-body text-ink">
                {machine.displayName}
                <span className="ml-1.5 text-meta text-ink-muted">{machine.ownerLogin ?? 'unknown owner'}</span>
                {machine.quarantined && <span className="ml-1.5 text-meta text-warning-5">locked — owner left</span>}
              </span>
              <select
                aria-label={`Transfer ${machine.displayName}`}
                value=""
                onChange={e => {
                  const userId = e.target.value
                  if (userId) void run(() => transferMachine(workspaceId, machine.id, userId))
                }}
                className={input}
              >
                <option value="">Transfer to…</option>
                {eligibleOwners
                  .filter(m => m.userId !== machine.ownerUserId || machine.quarantined)
                  .map(m => <option key={m.userId} value={m.userId}>{m.login}</option>)}
              </select>
              <button
                onClick={() => {
                  if (!window.confirm(`Remove ${machine.displayName}? Its connector is signed out and must be paired again.`)) return
                  void run(() => removeWorkspaceMachine(workspaceId, machine.id))
                }}
                className={`${button} hover:text-error-4`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-2 text-meta text-error-4">{error}</p>}
    </Block>
  )
}

/** The signed-in account's workspaces (from /api/me) and the one this tab is in. */
function useWorkspaceAccount(): { account: Account | null; workspace: Workspace | undefined; error: string | null } {
  const [account, setAccount] = useState<Account | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/me', { credentials: 'include' })
        const data = (await res.json()) as {
          user: { id: string } | null
          workspaces?: Workspace[]
          canCreateWorkspaces?: boolean
        }
        if (!data.user) return
        setAccount({
          userId: data.user.id,
          workspaces: data.workspaces ?? [],
          canCreateWorkspaces: data.canCreateWorkspaces ?? false,
        })
      } catch {
        setError('Could not load your workspaces.')
      }
    })()
  }, [])
  const workspaceId = currentWorkspaceId()
  return { account, workspace: account?.workspaces.find(w => w.id === workspaceId), error }
}

/** This tab's workspace's members, reloadable after a change. */
function useMembers(workspaceId: string | undefined, onError: (message: string | null) => void) {
  const [members, setMembers] = useState<WorkspaceMember[] | null>(null)
  const reload = useCallback(async () => {
    if (!workspaceId) return
    try {
      setMembers(await fetchMembers(workspaceId))
    } catch (err) {
      onError(errorText(err))
    }
  }, [workspaceId, onError])
  useEffect(() => {
    if (!workspaceId) return
    fetchMembers(workspaceId)
      .then(setMembers)
      .catch((err: unknown) => { onError(errorText(err)) })
  }, [workspaceId, onError])
  return { members, reload }
}

function Loading({ error }: { error: string | null }) {
  return error ? <p className="text-meta text-error-4">{error}</p> : <p className="text-body text-ink-muted">Loading…</p>
}

/** Workspace → General: name, switching and creating, 2FA policy, leave/delete. */
export function WorkspaceGeneral() {
  const { account, workspace, error: loadError } = useWorkspaceAccount()
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (!account || !workspace) return <Loading error={loadError} />

  const role = workspace.role
  const others = account.workspaces.filter(w => w.id !== workspace.id)

  const act = async (action: () => Promise<void>, after?: () => void) => {
    setError(null)
    try {
      await action()
      after?.()
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {renaming === null ? (
          <>
            <span className="min-w-0 truncate text-title text-ink">{workspace.name}</span>
            <span className="rounded-control border border-edge px-1.5 py-0.5 text-meta text-ink-muted">{ROLE_LABELS[role]}</span>
            {can(role, 'workspace.edit') && (
              <button onClick={() => { setRenaming(workspace.name) }} className={quietButton}>
                Rename
              </button>
            )}
          </>
        ) : (
          <form
            className="flex flex-1 items-center gap-2"
            onSubmit={e => {
              e.preventDefault()
              void act(() => renameWorkspace(workspace.id, renaming.trim()), () => { window.location.reload() })
            }}
          >
            <input
              aria-label="New workspace name"
              value={renaming}
              maxLength={64}
              onChange={e => { setRenaming(e.target.value) }}
              className={`${input} min-w-0 flex-1`}
            />
            <button type="submit" disabled={!renaming.trim()} className={button}>Save</button>
            <button type="button" onClick={() => { setRenaming(null) }} className={quietButton}>Cancel</button>
          </form>
        )}
      </div>

      {(others.length > 0 || account.canCreateWorkspaces) && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {others.length > 0 && (
            <select
              aria-label="Switch workspace"
              value=""
              onChange={e => { if (e.target.value) void switchWorkspace(e.target.value) }}
              className={input}
            >
              <option value="">Switch to…</option>
              {others.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          )}
          {account.canCreateWorkspaces && !creating && (
            <button onClick={() => { setCreating(true) }} className={button}>New workspace</button>
          )}
        </div>
      )}
      {creating && (
        <div className="mt-3">
          <CreateWorkspaceForm onCancel={() => { setCreating(false) }} />
        </div>
      )}

      {error && <p className="mt-3 text-meta text-error-4">{error}</p>}

      <div className="mt-4 border-t border-edge pt-3">
        <Rows>
          {can(role, 'workspace.edit') && (
            <Row
              label="Require two-factor authentication for everyone"
              htmlFor="workspace-require-mfa"
              description="Members without it are asked to set it up before they can continue. Owners and admins always need it."
              control={
                <input
                  id="workspace-require-mfa"
                  type="checkbox"
                  className={checkbox}
                  checked={workspace.requireMfa}
                  onChange={e => {
                    const next = e.target.checked
                    void act(() => setWorkspaceRequireMfa(workspace.id, next), () => { window.location.reload() })
                  }}
                />
              }
            />
          )}
          <Row
            label="Leave workspace"
            description="Your machines here are locked until an admin transfers or removes them."
            control={
              <button
                onClick={() => {
                  if (!window.confirm(`Leave ${workspace.name}? Your machines here are locked until an admin transfers or removes them.`)) return
                  void act(() => removeMember(workspace.id, account.userId), () => { void switchWorkspace(others.at(0)?.id ?? '') })
                }}
                className={dangerButton}
              >
                Leave workspace
              </button>
            }
          />
          {can(role, 'workspace.delete') && workspace.id !== BOOTSTRAP_WORKSPACE_ID && (
            <Row
              label="Delete workspace"
              description="Everyone loses access to it and its machines. This cannot be undone."
              control={
                <button
                  onClick={() => {
                    if (!window.confirm(`Delete ${workspace.name}? Everyone loses access to it and its machines. This cannot be undone.`)) return
                    void act(() => deleteWorkspace(workspace.id), () => { void switchWorkspace(others.at(0)?.id ?? '') })
                  }}
                  className={dangerButton}
                >
                  Delete workspace
                </button>
              }
            />
          )}
        </Rows>
      </div>
    </div>
  )
}

/** Workspace → Members: the member list with role controls, and invitations. */
export function WorkspaceMembers() {
  const { account, workspace, error: loadError } = useWorkspaceAccount()
  const [error, setError] = useState<string | null>(null)
  const { members, reload } = useMembers(workspace?.id, setError)

  if (!account || !workspace) return <Loading error={loadError} />
  const role = workspace.role

  return (
    <div>
      {members === null ? (
        <p className="text-body text-ink-muted">Loading…</p>
      ) : (
        <ul className="divide-y divide-edge">
          {members.map(member => (
            <MemberRow
              key={member.userId}
              member={member}
              actorRole={role}
              isSelf={member.userId === account.userId}
              onChanged={() => void reload()}
              onError={setError}
            />
          ))}
        </ul>
      )}
      {error && <p className="mt-3 text-meta text-error-4">{error}</p>}
      {can(role, 'member.invite') && <InvitationsPanel actorRole={role} />}
    </div>
  )
}

/** Workspace → Machines (owners and admins): every machine in the workspace. */
export function WorkspaceMachines() {
  const { account, workspace, error: loadError } = useWorkspaceAccount()
  const [error, setError] = useState<string | null>(null)
  const { members } = useMembers(workspace?.id, setError)

  if (!account || !workspace) return <Loading error={loadError} />
  if (!can(workspace.role, 'machine.oversee')) return null
  if (!members) return <Loading error={error} />
  return <MachineOversight members={members} />
}
