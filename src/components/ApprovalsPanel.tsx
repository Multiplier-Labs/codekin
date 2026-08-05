/**
 * Approvals — the Approvals tab's content renderer.
 *
 * Pure content: no header, no indent rail, no scroll container. `RepoDrawer`
 * owns those.
 *
 * Two halves of one question (task 08, item 12): "what am I auto-approving"
 * sits on top as the permission mode selector, "what have I already approved"
 * below it, grouped by tool — one row per decision with a count and a
 * revoke-all, instead of a flat list of patterns.
 */

import { useState, useEffect, useMemo, useCallback } from 'react'
import { IconChevronRight, IconShieldCheck, IconPencil, IconMap2, IconAlertTriangle, IconCheck, IconX } from '@tabler/icons-react'
import { getRepoApprovals, removeRepoApproval, bulkRemoveRepoApprovals, type RepoApprovals } from '../lib/ccApi'
import { PERMISSION_MODES, type PermissionMode } from '../types'

const PERMISSION_MODE_KEY = 'claude-permission-mode'

const PERMISSION_MODE_ICONS: Record<string, typeof IconShieldCheck> = {
  shield: IconShieldCheck,
  pencil: IconPencil,
  map: IconMap2,
  warning: IconAlertTriangle,
}

/** What `removeRepoApproval` / `bulkRemoveRepoApprovals` accept. */
type RemovalTarget = { tool?: string; command?: string; pattern?: string }

interface ApprovalGroup {
  key: string
  label: string
  kind: 'tool' | 'bash'
  rules: { id: string; label: string; target: RemovalTarget }[]
}

interface Props {
  token: string
  workingDir: string | null
  /** Defaults to true — the drawer only mounts the tab when it is showing. */
  visible?: boolean
  /** Filter text, when the host renders a filter row. */
  filter?: string
}

/**
 * Collapse the three flat rule lists into one decision per tool: every bash
 * command and wildcard pattern folds into the group of its leading binary.
 */
function buildGroups(approvals: RepoApprovals): ApprovalGroup[] {
  const tools: ApprovalGroup[] = [...approvals.tools].sort((a, b) => a.localeCompare(b)).map(tool => ({
    key: `tool:${tool}`,
    label: tool,
    kind: 'tool' as const,
    rules: [{ id: `tool:${tool}`, label: tool, target: { tool } }],
  }))

  const bash = new Map<string, ApprovalGroup>()
  function addBash(raw: string, target: RemovalTarget) {
    const prefix = raw.split(/\s+/)[0] || 'other'
    let group = bash.get(prefix)
    if (!group) {
      group = { key: `bash:${prefix}`, label: prefix, kind: 'bash', rules: [] }
      bash.set(prefix, group)
    }
    group.rules.push({ id: `${group.key}:${raw}`, label: raw, target })
  }
  for (const command of approvals.commands) addBash(command, { command })
  for (const pattern of approvals.patterns) addBash(pattern, { pattern })

  const bashGroups = [...bash.values()].sort((a, b) => a.label.localeCompare(b.label))
  for (const group of bashGroups) group.rules.sort((a, b) => a.label.localeCompare(b.label))

  return [...tools, ...bashGroups]
}

export function ApprovalsPanel({ token, workingDir, visible = true, filter = '' }: Props) {
  const [approvals, setApprovals] = useState<RepoApprovals | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [expanded, setExpanded] = useState(new Set<string>())

  useEffect(() => {
    if (!visible || !workingDir || !token) return
    let cancelled = false
    setLoading(true) // eslint-disable-line react-hooks/set-state-in-effect -- data fetching
    setError(false)
    getRepoApprovals(token, workingDir)
      .then(data => { if (!cancelled) setApprovals(data) })
      .catch(() => { if (!cancelled) { setApprovals(null); setError(true) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [visible, workingDir, token])

  const reload = useCallback(() => {
    if (!workingDir || !token) return
    getRepoApprovals(token, workingDir)
      .then(setApprovals)
      .catch(() => { /* keep the last good list */ })
  }, [token, workingDir])

  const handleRemove = useCallback((target: RemovalTarget) => {
    if (!workingDir || !token) return
    removeRepoApproval(token, workingDir, target)
      .catch((err: unknown) => { console.error('Failed to revoke approval:', err) })
      .finally(reload)
  }, [token, workingDir, reload])

  const handleRemoveMany = useCallback((targets: RemovalTarget[]) => {
    if (!workingDir || !token || targets.length === 0) return
    bulkRemoveRepoApprovals(token, workingDir, targets)
      .catch((err: unknown) => { console.error('Failed to revoke approvals:', err) })
      .finally(reload)
  }, [token, workingDir, reload])

  const toggleGroup = useCallback((key: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const groups = useMemo(() => (approvals ? buildGroups(approvals) : []), [approvals])

  const visibleGroups = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return groups
    return groups
      .map(g => g.label.toLowerCase().includes(needle)
        ? g
        : { ...g, rules: g.rules.filter(r => r.label.toLowerCase().includes(needle)) })
      .filter(g => g.rules.length > 0)
  }, [groups, filter])

  if (!visible) return null

  const ruleCount = groups.reduce((n, g) => n + g.rules.length, 0)

  return (
    <div className="flex flex-col">
      <PermissionModeControl />

      {!workingDir ? (
        <EmptyState
          title="No repo selected"
          body="Approvals are stored per repo. Pick a repo to see what it auto-approves."
        />
      ) : loading && !approvals ? (
        <p className="px-3 py-6 text-center text-body text-ink-muted">Loading…</p>
      ) : error || !approvals ? (
        <p className="px-3 py-6 text-center text-body text-ink-muted">Could not load approvals.</p>
      ) : ruleCount === 0 ? (
        <EmptyState
          title="Nothing auto-approved yet"
          body="When you answer a permission prompt with “always allow”, the rule lands here and Claude stops asking for it in this repo."
        />
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 px-3 py-1.5">
            <span className="text-micro uppercase tracking-wider text-ink-faint">
              {groups.length} tool{groups.length === 1 ? '' : 's'} · {ruleCount} rule{ruleCount === 1 ? '' : 's'}
            </span>
            <button
              onClick={() => {
                if (window.confirm(`Revoke all ${ruleCount} approval rules for this repo?`)) {
                  handleRemoveMany(groups.flatMap(g => g.rules.map(r => r.target)))
                }
              }}
              className="shrink-0 text-meta text-ink-muted transition-colors hover:text-error-5"
            >
              Revoke all
            </button>
          </div>

          {visibleGroups.length === 0 ? (
            <EmptyState title="No matching approvals" body={`Nothing approved here matches "${filter.trim()}".`} />
          ) : (
            <div className="flex flex-col pb-1">
              {visibleGroups.map(group => (
                <ApprovalGroupRow
                  key={group.key}
                  group={group}
                  expanded={expanded.has(group.key)}
                  onToggle={() => { toggleGroup(group.key) }}
                  onRemove={handleRemove}
                  onRemoveMany={handleRemoveMany}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/* ── Permission mode ────────────────────────────────────────────── */

function readPermissionMode(): PermissionMode {
  const stored = localStorage.getItem(PERMISSION_MODE_KEY)
  return PERMISSION_MODES.some(m => m.id === stored) ? stored as PermissionMode : 'acceptEdits'
}

/**
 * The other half of "what am I auto-approving". Writes the app-wide
 * `claude-permission-mode` key that new sessions start from — in-flight
 * sessions keep the mode they were started with.
 */
function PermissionModeControl() {
  const [mode, setMode] = useState<PermissionMode>(readPermissionMode)
  const [open, setOpen] = useState(false)

  const current = PERMISSION_MODES.find(m => m.id === mode)
  const CurrentIcon = PERMISSION_MODE_ICONS[current?.icon ?? 'shield']

  const select = useCallback((next: PermissionMode) => {
    const meta = PERMISSION_MODES.find(m => m.id === next)
    // Dangerous modes accept every tool call — same guard as the composer.
    if (meta?.dangerous) {
      const confirmed = window.confirm(
        `Warning: "${meta.label}" will accept ALL tool calls without asking.\n\n` +
        'This includes file writes, bash commands, and web requests. ' +
        'Only use this if you fully trust the task.\n\n' +
        'Are you sure?'
      )
      if (!confirmed) return
    }
    localStorage.setItem(PERMISSION_MODE_KEY, next)
    setMode(next)
    setOpen(false)
  }, [])

  return (
    <div className="border-b border-edge px-2 py-2">
      <p className="px-1 pb-1 text-micro uppercase tracking-wider text-ink-faint">New sessions start in</p>
      <button
        onClick={() => { setOpen(o => !o) }}
        aria-expanded={open}
        title="Permission mode for new sessions"
        className="density-row flex w-full items-center gap-2 rounded-control border border-edge-strong bg-surface-raised px-2 text-left transition-colors hover:border-focus"
      >
        <CurrentIcon size={14} stroke={2} className={current?.dangerous ? 'shrink-0 text-warning-4' : 'shrink-0 text-ink-muted'} />
        <span className={`min-w-0 flex-1 truncate text-body ${current?.dangerous ? 'text-warning-4' : 'text-ink'}`}>
          {current?.label ?? mode}
        </span>
        <IconChevronRight size={13} stroke={2} className={`shrink-0 text-ink-faint transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="mt-1 flex flex-col gap-0.5" role="group" aria-label="Permission mode">
          {PERMISSION_MODES.map(m => {
            const ModeIcon = PERMISSION_MODE_ICONS[m.icon]
            const active = m.id === mode
            return (
              <button
                key={m.id}
                onClick={() => { select(m.id) }}
                className={`flex w-full items-start gap-2 rounded-control px-2 py-1.5 text-left transition-colors ${
                  m.dangerous ? 'hover:bg-error-9/20' : 'hover:bg-surface-raised'
                }`}
              >
                <ModeIcon
                  size={14}
                  stroke={2}
                  className={`mt-0.5 shrink-0 ${m.dangerous ? 'text-error-5' : active ? 'text-primary-4' : 'text-ink-muted'}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className={`truncate text-body ${active ? 'font-medium text-ink' : 'text-ink-muted'}`}>{m.label}</span>
                    {active && <IconCheck size={12} stroke={2.5} className="shrink-0 text-primary-4" />}
                  </span>
                  <span className="mt-0.5 block text-micro text-ink-faint">{m.description}</span>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ── Groups ─────────────────────────────────────────────────────── */

function ApprovalGroupRow({ group, expanded, onToggle, onRemove, onRemoveMany }: {
  group: ApprovalGroup
  expanded: boolean
  onToggle: () => void
  onRemove: (target: RemovalTarget) => void
  onRemoveMany: (targets: RemovalTarget[]) => void
}) {
  const count = group.rules.length
  const labelClass = group.kind === 'bash' ? 'font-mono' : ''

  // A single rule is already one decision — no disclosure, revoke in place.
  if (count === 1) {
    const rule = group.rules[0]
    return (
      <div className="group density-row flex items-center gap-2 rounded-control px-3 transition-colors hover:bg-surface-raised">
        <span className={`min-w-0 flex-1 truncate text-body text-ink ${labelClass}`} title={rule.label}>
          {group.kind === 'bash' ? `$ ${rule.label}` : rule.label}
        </span>
        <RevokeButton label={`Revoke ${rule.label}`} onClick={() => { onRemove(rule.target) }} />
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      <div className="group density-row flex items-center gap-2 rounded-control px-3 transition-colors hover:bg-surface-raised">
        <button
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
        >
          <IconChevronRight
            size={12}
            stroke={2.5}
            className={`shrink-0 text-ink-faint transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
          <span className={`truncate text-body text-ink ${labelClass}`}>{group.label}</span>
          <span className="shrink-0 rounded-control bg-surface-raised px-1.5 text-micro tabular-nums text-ink-faint">{count}</span>
        </button>
        <button
          onClick={() => {
            if (window.confirm(`Revoke all ${count} "${group.label}" approvals?`)) {
              onRemoveMany(group.rules.map(r => r.target))
            }
          }}
          className="shrink-0 text-meta text-ink-faint transition-colors hover:text-error-5"
        >
          Revoke all
        </button>
      </div>
      {expanded && (
        <div className="flex flex-col pl-4">
          {group.rules.map(rule => (
            <div
              key={rule.id}
              className="group density-row flex items-center gap-2 rounded-control px-3 transition-colors hover:bg-surface-raised"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-meta text-ink-muted" title={rule.label}>
                {group.kind === 'bash' ? `$ ${rule.label}` : rule.label}
              </span>
              <RevokeButton label={`Revoke ${rule.label}`} onClick={() => { onRemove(rule.target) }} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function RevokeButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className="tap-target shrink-0 rounded-control p-0.5 text-ink-faint opacity-0 transition-opacity hover:text-error-5 focus-visible:opacity-100 group-hover:opacity-100"
    >
      <IconX size={13} stroke={2} />
    </button>
  )
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="px-4 py-8 text-center">
      <p className="text-body font-medium text-ink-muted">{title}</p>
      <p className="mt-1 text-meta text-ink-faint">{body}</p>
    </div>
  )
}
