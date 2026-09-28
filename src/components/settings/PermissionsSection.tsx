/**
 * Permissions: the mode new sessions start in (a browser setting, shared with
 * the composer through localStorage) and the auto-approval rules across every
 * repo on the connected machine, with a bulk revoke.
 */

import { useEffect, useMemo, useState } from 'react'
import { IconAlertTriangle } from '@tabler/icons-react'
import type { PermissionMode, Repo } from '../../types'
import { PERMISSION_MODES } from '../../types'
import { getRepoApprovals, bulkRemoveRepoApprovals } from '../../lib/ccApi'

/** localStorage key holding the permission mode new sessions start with. */
const PERMISSION_MODE_KEY = 'claude-permission-mode'

/** Aggregate of every repo's auto-approval rules. */
interface ApprovalSummary {
  /** Total rules (tools + commands + patterns) across all repos. */
  total: number
  /** How many repos contributed at least one rule. */
  repoCount: number
  /** Per-repo revoke payloads, keyed by workingDir. */
  byRepo: Array<{ workingDir: string; items: Array<{ tool?: string; command?: string; pattern?: string }> }>
}

interface Props {
  token: string
  repos: Repo[]
  onError: (message: string) => void
}

export function PermissionsSection({ token, repos, onError }: Props) {
  // Read on mount: the composer writes the same key when a session switches mode.
  const [defaultPermissionMode, setDefaultPermissionMode] = useState<PermissionMode>(
    () => (localStorage.getItem(PERMISSION_MODE_KEY) as PermissionMode | null) ?? 'acceptEdits',
  )
  const [approvalSummary, setApprovalSummary] = useState<ApprovalSummary | null>(null)
  const [approvalsLoading, setApprovalsLoading] = useState(false)
  const [approvalsError, setApprovalsError] = useState(false)
  const [revoking, setRevoking] = useState(false)
  const [approvalsNonce, setApprovalsNonce] = useState(0)

  // Stable list of repo working directories (the `repos` prop is a fresh array
  // on every parent render, so key on its contents instead of its identity).
  const repoDirsKey = repos.map(r => r.workingDir).filter(Boolean).sort().join('\n')
  const repoDirs = useMemo(() => (repoDirsKey ? repoDirsKey.split('\n') : []), [repoDirsKey])

  // Aggregate auto-approval rules across every known repo.
  useEffect(() => {
    if (!token || repoDirs.length === 0) return
    let cancelled = false
    setApprovalsLoading(true)
    setApprovalsError(false)
    void Promise.all(
      repoDirs.map(async workingDir => {
        try {
          const a = await getRepoApprovals(token, workingDir)
          const items: Array<{ tool?: string; command?: string; pattern?: string }> = [
            ...a.tools.map(tool => ({ tool })),
            ...a.commands.map(command => ({ command })),
            ...a.patterns.map(pattern => ({ pattern })),
          ]
          return { workingDir, items }
        } catch {
          return null
        }
      }),
    ).then(results => {
      if (cancelled) return
      const loaded = results.filter((r): r is { workingDir: string; items: Array<{ tool?: string; command?: string; pattern?: string }> } => r !== null)
      if (loaded.length === 0) {
        setApprovalSummary(null)
        setApprovalsError(true)
        return
      }
      const byRepo = loaded.filter(r => r.items.length > 0)
      setApprovalSummary({
        total: byRepo.reduce((n, r) => n + r.items.length, 0),
        repoCount: byRepo.length,
        byRepo,
      })
    }).finally(() => { if (!cancelled) setApprovalsLoading(false) })
    return () => { cancelled = true }
  }, [token, repoDirs, approvalsNonce])

  /**
   * Set the permission mode new sessions start with. Dangerous modes are
   * gated behind the same confirmation the composer uses.
   */
  function handleDefaultPermissionModeSelect(mode: PermissionMode) {
    const entry = PERMISSION_MODES.find(m => m.id === mode)
    if (entry?.dangerous) {
      const confirmed = window.confirm(
        `Warning: "${entry.label}" will accept ALL tool calls without asking.\n\n` +
        'This includes file writes, bash commands, and web requests. ' +
        'Only use this if you fully trust the task.\n\n' +
        'Every new session will start in this mode. Are you sure?'
      )
      if (!confirmed) return
    }
    localStorage.setItem(PERMISSION_MODE_KEY, mode)
    setDefaultPermissionMode(mode)
  }

  /** Revoke every auto-approval rule in every repo, one bulk call per repo. */
  async function handleRevokeAllApprovals() {
    if (!approvalSummary || approvalSummary.total === 0) return
    const confirmed = window.confirm(
      `Revoke all ${approvalSummary.total} approved pattern${approvalSummary.total !== 1 ? 's' : ''} ` +
      `across ${approvalSummary.repoCount} repo${approvalSummary.repoCount !== 1 ? 's' : ''}?\n\n` +
      'Claude will ask for permission again the next time it uses these tools.'
    )
    if (!confirmed) return
    setRevoking(true)
    try {
      await Promise.all(
        approvalSummary.byRepo.map(r => bulkRemoveRepoApprovals(token, r.workingDir, r.items)),
      )
    } catch {
      onError('Failed to revoke some approvals')
    } finally {
      setRevoking(false)
      setApprovalsNonce(n => n + 1)
    }
  }

  const activePermissionMode = PERMISSION_MODES.find(m => m.id === defaultPermissionMode)
  const dangerousDefault = activePermissionMode?.dangerous === true

  return (
    <div className="space-y-5">

      {/* ─ Default permission mode ─ */}
      <div>
        <label className="mb-1.5 block text-body text-ink-muted">Default permission mode for new sessions</label>
        <div className="flex flex-wrap gap-2">
          {PERMISSION_MODES.map(mode => {
            const selected = mode.id === defaultPermissionMode
            const selectedClass = mode.dangerous
              ? 'bg-error-8 text-ink-inverse'
              : 'bg-primary-8 text-on-primary'
            return (
              <button
                key={mode.id}
                type="button"
                onClick={() => { handleDefaultPermissionModeSelect(mode.id) }}
                title={mode.description}
                className={`rounded-control px-3 py-1.5 text-body font-medium transition-colors ${
                  selected ? selectedClass : 'border border-edge bg-surface-raised text-ink hover:bg-edge'
                }`}
              >
                {mode.label}
              </button>
            )
          })}
        </div>
        <p className="mt-1 text-body text-ink-muted">
          {activePermissionMode?.description ?? 'Mode every new session starts in.'} Existing sessions keep their own mode.
        </p>
      </div>

      {/* ─ Dangerous default warning ─ */}
      {dangerousDefault && (
        <div className="flex items-start gap-2 rounded-control border border-warning-9/50 bg-warning-9/10 px-3 py-2">
          <IconAlertTriangle size={14} className="text-warning-5 mt-0.5 shrink-0" />
          <p className="text-body text-warning-5">
            Every new session starts with &ldquo;{activePermissionMode.label}&rdquo; and will run tool calls
            &mdash; file writes, bash commands, web requests &mdash; without asking.
            Codekin stores permission mode app-wide, not per repo, so this is the only place it can be checked;
            a repo cannot opt out on its own.
          </p>
        </div>
      )}

      <div className="border-t border-edge" />

      {/* ─ Approved patterns across repos ─ */}
      <div>
        <label className="mb-1.5 block text-body text-ink-muted">Auto-approved patterns</label>
        {repoDirs.length === 0 ? (
          <p className="text-body text-ink-muted">No repos loaded.</p>
        ) : approvalsLoading ? (
          <p className="text-body text-ink-muted">Loading approvals...</p>
        ) : approvalsError ? (
          <p className="text-body text-ink-muted">Could not load approvals.</p>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <span className="text-body text-ink">
              {approvalSummary?.total ?? 0} approved pattern{(approvalSummary?.total ?? 0) !== 1 ? 's' : ''}
              {' '}across {approvalSummary?.repoCount ?? 0} repo{(approvalSummary?.repoCount ?? 0) !== 1 ? 's' : ''}
            </span>
            <button
              type="button"
              onClick={() => { void handleRevokeAllApprovals() }}
              disabled={revoking || (approvalSummary?.total ?? 0) === 0}
              className="rounded-control border border-edge bg-surface-raised px-3 py-1.5 text-body font-medium text-ink hover:bg-edge hover:text-error-5 disabled:opacity-50 transition-colors"
            >
              {revoking ? 'Revoking...' : 'Revoke all'}
            </button>
          </div>
        )}
        <p className="mt-1 text-body text-ink-muted">
          Tools, bash commands and patterns Claude may run without asking. Scanned across {repoDirs.length} repo{repoDirs.length !== 1 ? 's' : ''}.
        </p>
      </div>

    </div>
  )
}
