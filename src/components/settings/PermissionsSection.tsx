/**
 * Permissions: the mode new sessions start in (a stored preference, shared with
 * the composer through the prefs store) and every auto-approval rule on the
 * connected machine, grouped by repo and then by tool, with revoke at each
 * level.
 */

import { useEffect, useState } from 'react'
import { IconAlertTriangle, IconCheck, IconChevronRight } from '@tabler/icons-react'
import type { PermissionMode, Repo } from '../../types'
import { PERMISSION_MODES } from '../../types'
import { getAllRepoApprovals, removeRepoApproval, bulkRemoveRepoApprovals, type RepoApprovalsEntry } from '../../lib/ccApi'
import { ApprovalGroupRow } from '../ApprovalsPanel'
import { PERMISSION_MODE_ICONS, buildGroups, type ApprovalGroup, type RemovalTarget } from '../../lib/approvalGroups'
import { Block, button, checkbox } from './Block'
import { getPref, setPref, usePref } from '../../lib/prefs'
import { resolveEnabledModes } from '../../lib/permissionModes'


/** Show the filter once there are more repos than fit at a glance. */
const FILTER_THRESHOLD = 4

interface Props {
  token: string
  repos: Repo[]
  onError: (message: string) => void
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; entries: RepoApprovalsEntry[] }

/** One repo's rules, grouped the way the repo drawer groups them. */
interface RepoRules {
  workingDir: string
  name: string
  groups: ApprovalGroup[]
  count: number
}

function readPermissionMode(): PermissionMode {
  const stored = getPref('permissionMode')
  return PERMISSION_MODES.some(m => m.id === stored) ? stored as PermissionMode : 'acceptEdits'
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export function PermissionsSection({ token, repos, onError }: Props) {
  return (
    <div className="space-y-4">
      <DefaultModeBlock />
      <EnabledModesBlock />
      <ApprovedRulesBlock token={token} repos={repos} onError={onError} />
    </div>
  )
}

/* ── Default mode ───────────────────────────────────────────────── */

function DefaultModeBlock() {
  // Read on mount: the composer writes the same pref when a session switches mode.
  const [mode, setMode] = useState<PermissionMode>(readPermissionMode)
  const current = PERMISSION_MODES.find(m => m.id === mode)

  /** Dangerous modes are gated behind the same confirmation the composer uses. */
  function select(next: PermissionMode) {
    if (next === mode) return
    const entry = PERMISSION_MODES.find(m => m.id === next)
    if (entry?.dangerous) {
      const confirmed = window.confirm(
        `Warning: "${entry.label}" will accept ALL tool calls without asking.\n\n` +
        'This includes file writes, bash commands, and web requests. ' +
        'Only use this if you fully trust the task.\n\n' +
        'Every new session will start in this mode. Are you sure?'
      )
      if (!confirmed) return
      // Already accepted here, so the composer won't ask again for this mode.
      const accepted = getPref('confirmedDangerousModes') ?? []
      if (!accepted.includes(next)) setPref('confirmedDangerousModes', [...accepted, next])
    }
    setPref('permissionMode', next)
    setMode(next)
    // The default is always on in the composer.
    const enabled = getPref('enabledPermissionModes')
    if (enabled && !enabled.includes(next)) setPref('enabledPermissionModes', [...enabled, next])
  }

  return (
    <Block title="New sessions start in" description="Sessions already running keep their own mode.">
      <div role="radiogroup" aria-label="Default permission mode" className="flex flex-col gap-1">
        {PERMISSION_MODES.map(m => {
          const ModeIcon = PERMISSION_MODE_ICONS[m.icon]
          const active = m.id === mode
          return (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => { select(m.id) }}
              className={`flex w-full items-start gap-3 rounded-control border px-3 py-2.5 text-left transition-colors ${
                active
                  ? m.dangerous ? 'border-error-7 bg-error-9/15' : 'border-primary-7 bg-surface-raised'
                  : 'border-transparent hover:bg-surface-raised'
              }`}
            >
              <ModeIcon
                size={16}
                stroke={2}
                className={`mt-0.5 shrink-0 ${m.dangerous ? 'text-error-5' : active ? 'text-primary-4' : 'text-ink-muted'}`}
              />
              <span className="min-w-0 flex-1">
                <span className={`block text-body ${active ? 'font-medium text-ink' : 'text-ink'}`}>{m.label}</span>
                <span className="block text-meta text-ink-muted">{m.description}</span>
              </span>
              {active && <IconCheck size={16} stroke={2.5} className={`mt-0.5 shrink-0 ${m.dangerous ? 'text-error-5' : 'text-primary-4'}`} />}
            </button>
          )
        })}
      </div>

      {current?.dangerous && (
        <div className="mt-3 flex items-start gap-2 rounded-control border border-warning-9/50 bg-warning-9/10 px-3 py-2">
          <IconAlertTriangle size={14} className="mt-0.5 shrink-0 text-warning-5" />
          <p className="text-meta text-warning-5">
            Every new session will run tool calls &mdash; file writes, bash commands, web requests &mdash; without
            asking. The mode is app-wide: no repo can opt out on its own.
          </p>
        </div>
      )}
    </Block>
  )
}

/* ── Modes in the composer ─────────────────────────────────────── */

function EnabledModesBlock() {
  const enabled = resolveEnabledModes(usePref('enabledPermissionModes'))
  // Track the default live: it can't be switched off while it is the default.
  const defaultMode = (usePref('permissionMode') ?? readPermissionMode())
  const confirmedIds = usePref('confirmedDangerousModes') ?? []
  const confirmedLabels = PERMISSION_MODES.filter(m => m.dangerous && confirmedIds.includes(m.id)).map(m => m.label)

  function toggle(id: PermissionMode) {
    const next = enabled.includes(id) ? enabled.filter(m => m !== id) : [...enabled, id]
    // Store all-on as unset, so modes added in later versions show up too.
    setPref('enabledPermissionModes', next.length === PERMISSION_MODES.length ? undefined : next)
  }

  return (
    <Block
      title="Modes in the composer"
      description="Which modes the composer's mode menu offers and Shift+Tab steps through while typing."
    >
      <div className="flex flex-col gap-1">
        {PERMISSION_MODES.map(m => {
          const ModeIcon = PERMISSION_MODE_ICONS[m.icon]
          const on = enabled.includes(m.id)
          const isDefault = m.id === defaultMode
          // Keep at least one mode, and always the one new sessions start in.
          const locked = isDefault || (on && enabled.length === 1)
          return (
            <label
              key={m.id}
              className={`flex w-full items-start gap-3 rounded-control px-3 py-2 transition-colors ${locked ? '' : 'cursor-pointer hover:bg-surface-raised'}`}
            >
              <input
                type="checkbox"
                checked={on}
                disabled={locked}
                onChange={() => { toggle(m.id) }}
                className={`${checkbox} mt-0.5 shrink-0 disabled:cursor-default disabled:opacity-60`}
              />
              <ModeIcon
                size={16}
                stroke={2}
                className={`mt-0.5 shrink-0 ${m.dangerous ? 'text-error-5' : 'text-ink-muted'}`}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-body text-ink">{m.label}</span>
                {isDefault && <span className="block text-meta text-ink-muted">New sessions start in this mode</span>}
              </span>
            </label>
          )
        })}
      </div>
      {confirmedLabels.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-meta text-ink-muted">
            You've confirmed: {confirmedLabels.join(', ')}. The composer switches to {confirmedLabels.length === 1 ? 'it' : 'these'} without asking.
          </p>
          <button type="button" className={button} onClick={() => { setPref('confirmedDangerousModes', undefined) }}>
            Ask again
          </button>
        </div>
      ) : enabled.some(id => PERMISSION_MODES.find(m => m.id === id)?.dangerous) && (
        <p className="mt-2 text-meta text-ink-muted">
          The composer asks once before a mode that runs tools without asking; declining skips past it.
        </p>
      )}
    </Block>
  )
}

/* ── Approved rules ─────────────────────────────────────────────── */

function ApprovedRulesBlock({ token, repos, onError }: Props) {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [nonce, setNonce] = useState(0)
  const [filter, setFilter] = useState('')
  const [openRepos, setOpenRepos] = useState(new Set<string>())
  const [openGroups, setOpenGroups] = useState(new Set<string>())
  const [revoking, setRevoking] = useState(false)

  // The `repos` prop is a fresh array on every parent render, so key on its
  // contents instead of its identity.
  const repoDirsKey = repos.map(r => r.workingDir).filter(Boolean).sort().join('\n')
  const repoNames = new Map(repos.map(r => [r.workingDir, r.name]))

  // One request for the whole machine (see getAllRepoApprovals). A reload
  // keeps the current list on screen until the new one arrives.
  useEffect(() => {
    if (!token) return
    let cancelled = false
    const dirs = repoDirsKey ? repoDirsKey.split('\n') : []
    getAllRepoApprovals(token, dirs)
      .then(entries => { if (!cancelled) setState({ status: 'ready', entries }) })
      .catch(() => { if (!cancelled) setState({ status: 'error' }) })
    return () => { cancelled = true }
  }, [token, repoDirsKey, nonce])

  const reload = () => { setNonce(n => n + 1) }

  const rules: RepoRules[] = state.status !== 'ready' ? [] : state.entries.map(e => {
    const groups = buildGroups(e)
    return {
      workingDir: e.workingDir,
      name: repoNames.get(e.workingDir) ?? e.workingDir.split('/').filter(Boolean).pop() ?? e.workingDir,
      groups,
      count: groups.reduce((n, g) => n + g.rules.length, 0),
    }
  }).sort((a, b) => a.name.localeCompare(b.name))

  // A repo matches on its name or path (all its rules shown), otherwise on
  // any rule; a filter opens every matching repo.
  const needle = filter.trim().toLowerCase()
  const visible = !needle ? rules : rules.flatMap(r => {
    if (r.name.toLowerCase().includes(needle) || r.workingDir.toLowerCase().includes(needle)) return [r]
    const groups = r.groups
      .map(g => g.label.toLowerCase().includes(needle)
        ? g
        : { ...g, rules: g.rules.filter(rule => rule.label.toLowerCase().includes(needle)) })
      .filter(g => g.rules.length > 0)
    return groups.length > 0 ? [{ ...r, groups }] : []
  })

  const total = rules.reduce((n, r) => n + r.count, 0)

  function toggle(setter: typeof setOpenRepos, key: string) {
    setter(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function revoke(workingDir: string, targets: RemovalTarget[]) {
    if (targets.length === 0) return
    const request = targets.length === 1
      ? removeRepoApproval(token, workingDir, targets[0])
      : bulkRemoveRepoApprovals(token, workingDir, targets)
    request.catch(() => { onError('Failed to revoke approval') }).finally(reload)
  }

  /** One bulk call per repo, in sequence — never a burst across every repo. */
  async function revokeAll() {
    if (total === 0) return
    const confirmed = window.confirm(
      `Revoke all ${plural(total, 'approval rule')} across ${plural(rules.length, 'repo')}?\n\n` +
      'Claude will ask for permission again the next time it uses these tools.'
    )
    if (!confirmed) return
    setRevoking(true)
    let failed = false
    for (const r of rules) {
      try {
        await bulkRemoveRepoApprovals(token, r.workingDir, r.groups.flatMap(g => g.rules.map(rule => rule.target)))
      } catch {
        failed = true
      }
    }
    if (failed) onError('Failed to revoke some approvals')
    setRevoking(false)
    reload()
  }

  const revokeAllButton = state.status === 'ready' && total > 0 && (
    <button
      type="button"
      onClick={() => { void revokeAll() }}
      disabled={revoking}
      className={`${button} shrink-0 hover:text-error-5`}
    >
      {revoking ? 'Revoking…' : 'Revoke all'}
    </button>
  )

  let body: React.ReactNode
  if (!token) {
    body = <p className="text-body text-ink-muted">Connect to a server to see its approval rules.</p>
  } else if (state.status === 'loading') {
    body = <p className="text-body text-ink-muted">Loading approvals…</p>
  } else if (state.status === 'error') {
    body = (
      <div className="flex items-center gap-3">
        <p className="flex-1 text-body text-ink-muted">Could not load approvals.</p>
        <button
          type="button"
          onClick={() => { setState({ status: 'loading' }); reload() }}
          className={button}
        >
          Retry
        </button>
      </div>
    )
  } else if (rules.length === 0) {
    body = (
      <p className="text-body text-ink-muted">
        Nothing is auto-approved yet. When you answer a permission prompt with &ldquo;always allow&rdquo;, the rule
        lands here and Claude stops asking for it in that repo.
      </p>
    )
  } else {
    body = (
      <>
        <p className="mb-3 text-meta text-ink-muted">
          {plural(total, 'rule')} in {plural(rules.length, 'repo')}.
        </p>
        {rules.length >= FILTER_THRESHOLD && (
          <input
            type="search"
            value={filter}
            onChange={e => { setFilter(e.target.value) }}
            placeholder="Filter by repo, tool or command"
            aria-label="Filter approvals"
            className="mb-2 w-full rounded-control border border-edge bg-page px-3 py-1.5 text-body text-ink placeholder:text-ink-faint focus:border-focus focus:outline-none"
          />
        )}
        {visible.length === 0 ? (
          <p className="py-2 text-body text-ink-muted">Nothing matches &ldquo;{filter.trim()}&rdquo;.</p>
        ) : (
          <div className="flex flex-col divide-y divide-edge rounded-control border border-edge">
            {visible.map(r => {
              const open = needle !== '' || openRepos.has(r.workingDir)
              const shown = r.groups.reduce((n, g) => n + g.rules.length, 0)
              return (
                <div key={r.workingDir}>
                  <div className="group density-row flex items-center gap-2 px-3 transition-colors hover:bg-surface-raised">
                    <button
                      type="button"
                      onClick={() => { toggle(setOpenRepos, r.workingDir) }}
                      aria-expanded={open}
                      className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
                    >
                      <IconChevronRight size={13} stroke={2.5} className={`shrink-0 text-ink-faint transition-transform ${open ? 'rotate-90' : ''}`} />
                      <span className="shrink-0 text-body font-medium text-ink">{r.name}</span>
                      <span className="min-w-0 truncate text-meta text-ink-muted" title={r.workingDir}>{r.workingDir}</span>
                    </button>
                    <span className="shrink-0 rounded-control bg-surface-raised px-1.5 text-meta tabular-nums text-ink-muted">{shown}</span>
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm(`Revoke all ${plural(r.count, 'approval rule')} in ${r.name}?`)) {
                          revoke(r.workingDir, r.groups.flatMap(g => g.rules.map(rule => rule.target)))
                        }
                      }}
                      className="shrink-0 text-meta text-ink-muted transition-colors hover:text-error-5"
                    >
                      Revoke
                    </button>
                  </div>
                  {open && (
                    <div className="flex flex-col pb-1 pl-5">
                      {r.groups.map(g => {
                        const key = `${r.workingDir}\0${g.key}`
                        return (
                          <ApprovalGroupRow
                            key={key}
                            group={g}
                            expanded={needle !== '' || openGroups.has(key)}
                            onToggle={() => { toggle(setOpenGroups, key) }}
                            onRemove={target => { revoke(r.workingDir, [target]) }}
                            onRemoveMany={targets => { revoke(r.workingDir, targets) }}
                          />
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </>
    )
  }

  return (
    <Block
      title="Auto-approved rules"
      description="Tools and commands Claude runs without asking, in the repo they were approved in."
      action={revokeAllButton}
    >
      {body}
    </Block>
  )
}
