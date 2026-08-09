/**
 * RepoSection — one repo's sessions in the left sidebar.
 *
 * The repo is a section label, not a tree row: sessions sit flush beneath it
 * at one depth level, which is what buys back name width at the 160px minimum
 * sidebar. Every row action lives behind a persistent overflow menu, so
 * nothing is reachable only on hover — the one hover affordance, "New session",
 * also shows on touch and on keyboard focus.
 *
 * Docs, approvals and archived sessions no longer expand inside the tree —
 * they live in the repo drawer, and this component only deep-links to them.
 */

import { useState, useEffect } from 'react'
import {
  IconPlus, IconShieldCheck, IconArchive, IconFileText,
  IconRobot, IconSparkles, IconPencil, IconGitBranch, IconRobotFace, IconTrash,
} from '@tabler/icons-react'
import type { Session, CodingProvider } from '../types'
import { PROVIDERS } from '../types'
import { RowMenu, type RowMenuItem } from './RowMenu'
import type { RepoDrawerTab } from './RepoDrawer'

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function sessionDisplayName(session: Session): string {
  const name = session.name || session.id.slice(0, 8)
  if (name.startsWith('hub:')) return 'new session'
  return name
}

function compactAge(created: string): string {
  const createdMs = new Date(created).getTime()
  // An unparsable timestamp would render as "NaNs" — show nothing instead.
  if (isNaN(createdMs)) return ''
  const seconds = Math.floor((Date.now() - createdMs) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/**
 * The harness a session runs on, spelled out.
 *
 * Two-letter codes were tried and dropped: every harness name contains a C and
 * all-caps share one x-height, so CC / CX / OC render as three near-identical
 * rectangles at 11px. Spelled names differ in length, which is what the eye
 * actually picks up, and there is nothing to learn. A session with no provider
 * predates the field and is Claude by the same default the server applies.
 */
function harnessLabel(provider: Session['provider']): string {
  return PROVIDERS.find(p => p.id === (provider ?? 'claude'))?.label ?? 'Claude'
}

/** Row tooltip: the harness, plus the pinned model where the session has one. */
function harnessTitle(session: Session): string {
  const harness = `${harnessLabel(session.provider)} session`
  return session.model ? `${harness} · ${session.model}` : harness
}

/**
 * Exactly three status treatments, and only one of them animates:
 * filled = running, amber pulsing = waiting for you, hollow ring = idle.
 * Anything finer (queued, inactive) is carried by the tooltip, not by a
 * fourth colour.
 */
type SessionStatus = 'running' | 'waiting' | 'idle'

function StatusDot({ status, title }: { status: SessionStatus; title: string }) {
  const shape = status === 'waiting'
    ? 'bg-warning-5 animate-pulse'
    : status === 'running'
    ? 'bg-success-6'
    : 'border border-ink-faint'
  return (
    <span className="inline-flex w-3 flex-shrink-0 items-center justify-center" title={title}>
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${shape}`} />
    </span>
  )
}

/** Where a session came from — a separate glyph so origin stops competing with state. */
function OriginGlyph({ source }: { source?: string }) {
  const [Icon, label] = source === 'workflow'
    ? [IconSparkles, 'Started by a workflow']
    : source === 'webhook'
    ? [IconRobot, 'Started by a webhook']
    : source === 'orchestrator' || source === 'agent'
    ? [IconRobotFace, 'Started by an agent']
    : [null, '']
  if (!Icon) return null
  return (
    <span className="flex-shrink-0 text-ink-faint" title={label}>
      <Icon size={12} stroke={2} />
    </span>
  )
}

function sessionStatus(
  session: Session,
  waiting: boolean | undefined,
  tentative: boolean,
): [SessionStatus, string] {
  if (waiting) return ['waiting', 'Waiting for input']
  if (tentative) return ['running', 'Queued']
  if (session.isProcessing) return ['running', 'Processing']
  return ['idle', session.active ? 'Idle' : 'Inactive']
}

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

export interface RepoNode {
  workingDir: string
  displayName: string
  sessions: Session[]
  hasWaiting: boolean
  hasActive: boolean
  hasTentative: boolean
}

export interface RepoSectionProps {
  node: RepoNode
  isActive: boolean
  activeSessionId: string | null
  waitingSessions: Record<string, boolean>
  tentativeQueues: Record<string, { text: string; files: File[] }[]>
  onSelectSession: (id: string) => void
  onDeleteSession: (id: string) => void
  onRenameSession: (id: string, name: string) => void
  /** Start a session in this repo — the hover-revealed row under its sessions. */
  onNewSession?: (provider?: CodingProvider) => void
  onSelectRepo: (workingDir: string) => void
  onDeleteRepo: (workingDir: string) => void
  /** Open the repo drawer on a given tab. */
  onOpenDrawer: (workingDir: string, tab: RepoDrawerTab) => void
  /** Move the active session into a git worktree — only offered for the joined session. */
  onMoveToWorktree?: () => void
}

// --------------------------------------------------------------------------
// Component
// --------------------------------------------------------------------------

export function RepoSection({
  node,
  isActive,
  activeSessionId,
  waitingSessions,
  tentativeQueues,
  onSelectSession,
  onDeleteSession,
  onRenameSession,
  onNewSession,
  onSelectRepo,
  onDeleteRepo,
  onOpenDrawer,
  onMoveToWorktree,
}: RepoSectionProps) {
  const [expanded, setExpanded] = useState(true)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')

  // Auto-expand when this repo becomes active
  useEffect(() => {
    if (isActive) setExpanded(true) // eslint-disable-line react-hooks/set-state-in-effect -- sync expansion with external active-repo state
  }, [isActive])

  // The label carries the worst status among its children.
  const [repoStatus, repoStatusTitle]: [SessionStatus, string] = node.hasWaiting
    ? ['waiting', 'Waiting for input']
    : node.hasActive || node.hasTentative
    ? ['running', node.hasActive ? 'Processing' : 'Queued']
    : ['idle', 'Idle']

  const startEditing = (s: Session) => {
    setEditingSessionId(s.id)
    setEditValue(sessionDisplayName(s))
  }

  const commitRename = () => {
    if (editingSessionId && editValue.trim()) {
      onRenameSession(editingSessionId, editValue.trim())
    }
    setEditingSessionId(null)
  }

  const repoMenuItems: RowMenuItem[] = [
    { label: 'Docs', icon: <IconFileText size={14} stroke={2} />, onSelect: () => onOpenDrawer(node.workingDir, 'docs') },
    { label: 'Archived sessions', icon: <IconArchive size={14} stroke={2} />, onSelect: () => onOpenDrawer(node.workingDir, 'archive') },
    { label: 'Approvals', icon: <IconShieldCheck size={14} stroke={2} />, onSelect: () => onOpenDrawer(node.workingDir, 'approvals') },
    { label: 'Close sessions', icon: <IconTrash size={14} stroke={2} />, onSelect: () => onDeleteRepo(node.workingDir), danger: true, separated: true },
  ]

  return (
    <div className="section-reveal mb-1">
      {/* Repo label — a section header, not a row */}
      <div className="flex items-center gap-1.5 px-[18px] pt-2 pb-1.5">
        <button
          onClick={() => { setExpanded(!expanded); if (!isActive) onSelectRepo(node.workingDir) }}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-control text-left text-micro font-medium uppercase tracking-wider text-ink-faint transition-colors hover:text-ink"
          title={node.workingDir}
        >
          <StatusDot status={repoStatus} title={repoStatusTitle} />
          <span className="truncate">{node.displayName}</span>
          {!expanded && node.sessions.length > 0 && (
            <span className="flex-shrink-0 tabular-nums normal-case tracking-normal">({node.sessions.length})</span>
          )}
        </button>
        <RowMenu items={repoMenuItems} label={`Actions for ${node.displayName}`} />
      </div>

      {/* Sessions — flush beneath the label, one depth level */}
      {expanded && (
        <div className="px-2">
          {node.sessions.map(s => {
            const isActiveSession = s.id === activeSessionId
            const isTentative = (tentativeQueues[s.id]?.length ?? 0) > 0
            const [status, statusTitle] = sessionStatus(s, waitingSessions[s.id], isTentative)
            const isEditing = editingSessionId === s.id

            const menuItems: RowMenuItem[] = [
              { label: 'Rename', icon: <IconPencil size={14} stroke={2} />, onSelect: () => startEditing(s) },
              // move_to_worktree acts on the joined session, so it is only
              // offered for the session actually in view.
              ...(isActiveSession && onMoveToWorktree && !s.worktreePath
                ? [{ label: 'Move to worktree', icon: <IconGitBranch size={14} stroke={2} />, onSelect: onMoveToWorktree }]
                : []),
              {
                label: 'Close & archive',
                icon: <IconArchive size={14} stroke={2} />,
                onSelect: () => onDeleteSession(s.id),
                danger: true,
                separated: true,
              },
            ]

            if (isEditing) {
              return (
                <div key={s.id} className="density-row flex items-center gap-2 rounded-control pl-6 pr-2">
                  <input
                    autoFocus
                    value={editValue}
                    onChange={e => setEditValue(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={e => {
                      if (e.key === 'Enter') commitRename()
                      if (e.key === 'Escape') setEditingSessionId(null)
                    }}
                    className="min-w-0 flex-1 rounded-control border border-edge-strong bg-surface px-1 py-0 text-body text-ink outline-none focus:border-focus"
                  />
                </div>
              )
            }

            return (
              // Two lines, because at 236px one cannot hold a real title and
              // two metadata facts: the title truncated at about 60% while the
              // metadata beside it rendered whole. Metadata gets its own line,
              // and the title gets the width. The cost is roughly two fewer
              // sessions visible with three repos open.
              <div
                key={s.id}
                className={`row-reveal flex w-full flex-col gap-0.5 rounded-control py-1 pl-6 pr-2.5 transition-colors ${
                  isActiveSession
                    ? 'bg-accent-9/30 text-accent-2'
                    : 'text-ink hover:bg-surface-raised'
                }`}
              >
                {/* Line one: status, title, overflow. The title is the only
                    thing that flexes, and the ⋯ holds its slot on every row
                    (it is revealed by opacity), so this line ends at a
                    constant right edge. */}
                <div className="flex w-full items-center gap-1.5">
                  <button
                    onClick={() => onSelectSession(s.id)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-body"
                  >
                    <StatusDot status={status} title={statusTitle} />
                    <span className="truncate">{sessionDisplayName(s)}</span>
                  </button>
                  <RowMenu items={menuItems} label={`Actions for ${sessionDisplayName(s)}`} className="row-menu-reveal" />
                </div>

                {/* Line two: where it runs and how old it is. Indented just
                    past the status dot. The harness sits one step ahead of the
                    age — the same step on an active row, in accent rather than
                    ink. */}
                <div className="flex items-center gap-1 pl-[13px] font-mono text-meta leading-tight">
                  {s.worktreePath ? (
                    <span
                      title={`In a worktree: ${s.worktreePath.split('/').pop() ?? ''}`}
                      className={`flex-shrink-0 ${isActiveSession ? 'text-accent-3' : 'text-primary-5'}`}
                    >
                      <IconGitBranch size={12} stroke={2} />
                    </span>
                  ) : (
                    <OriginGlyph source={s.source} />
                  )}
                  <span
                    title={harnessTitle(s)}
                    className={`text-micro font-medium ${isActiveSession ? 'text-accent-3' : 'text-ink-muted'}`}
                  >
                    {harnessLabel(s.provider)}
                  </span>
                  <span className={isActiveSession ? 'text-accent-4' : 'text-ink-faint'}>·</span>
                  <span className={`tabular-nums ${isActiveSession ? 'text-accent-4' : 'text-ink-faint'}`}>
                    {compactAge(s.created)}
                  </span>
                </div>
              </div>
            )
          })}

          {/* New session in this repo. Revealed by hovering the section, on the
              same terms as a row's overflow menu: visible on touch, while
              focused, and while its own provider menu is open. */}
          {onNewSession && (
            <RowMenu
              label="New session in this repo"
              className="section-reveal-target"
              triggerClassName="density-row flex w-full items-center gap-1.5 rounded-control pl-6 pr-2.5 text-left text-body text-ink-muted transition-colors hover:bg-surface-raised hover:text-ink aria-expanded:bg-surface-raised aria-expanded:text-ink"
              trigger={
                <>
                  <span className="inline-flex w-3 flex-shrink-0 items-center justify-center">
                    <IconPlus size={12} stroke={2} />
                  </span>
                  <span className="truncate">New session</span>
                </>
              }
              items={PROVIDERS.map(p => ({
                label: p.label,
                title: p.description,
                onSelect: () => { onNewSession(p.id) },
              }))}
            />
          )}
        </div>
      )}
    </div>
  )
}
