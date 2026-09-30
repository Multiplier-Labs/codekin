/**
 * Joe's Tasks tab — the per-repo task list (docs/JOE-TASKS-SPEC.md).
 *
 * Answers "what happened while I was away?" in three short lists instead of
 * three transcripts: Needs your decision, Ready for review, In progress.
 * To do and closed tasks sit below. "Delegate tasks" hands new work to Joe.
 */

import { useState } from 'react'
import {
  IconPlus, IconExternalLink, IconTerminal2, IconCheck, IconMessageCircle, IconRefresh, IconChevronRight,
} from '@tabler/icons-react'
import type { Repo } from '../types'
import {
  acceptTask, answerDecision, repoName, requestChanges, setTaskStatus, startTask,
  type JoeTask, type TaskList, type TaskStatus,
} from '../lib/tasksApi'
import { DelegateTasksDialog } from './DelegateTasksDialog'

interface Props {
  token: string
  data: TaskList | null
  error: string | null
  repos: Repo[]
  /** Repo filter ('' = all repos). */
  repoFilter: string
  onRepoFilterChange: (repo: string) => void
  /** Reload after an action (push events also refresh). */
  onChanged: () => void
  onOpenSession?: (sessionId: string) => void
  agentName?: string
}

const SECTIONS: { status: TaskStatus; title: string; empty?: string }[] = [
  { status: 'needs_decision', title: 'Needs your decision' },
  { status: 'in_review', title: 'Ready for review' },
  { status: 'in_progress', title: 'In progress' },
  { status: 'todo', title: 'To do' },
]

const PRIORITY_ORDER = { high: 0, normal: 1, low: 2 } as const

const buttonSecondary = 'inline-flex items-center gap-1 rounded-control border border-edge px-2.5 py-1 text-meta text-ink hover:border-edge-strong disabled:opacity-40'
const buttonPrimary = 'inline-flex items-center gap-1 rounded-control bg-primary-8 px-2.5 py-1 text-meta font-medium text-on-primary hover:bg-primary-7 disabled:opacity-40'

export function JoeTasksView({ token, data, error, repos, repoFilter, onRepoFilterChange, onChanged, onOpenSession, agentName = 'Joe' }: Props) {
  const [delegating, setDelegating] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  /** Run a task action, surface failures, and refresh. */
  async function act(id: string, action: () => Promise<unknown>) {
    setBusyId(id)
    setActionError(null)
    try {
      await action()
      onChanged()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setBusyId(null)
    }
  }

  const tasks = data?.tasks ?? []
  const byStatus = (status: TaskStatus) => tasks
    .filter(t => t.status === status)
    .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || b.updatedAt.localeCompare(a.updatedAt))
  const closed = tasks.filter(t => t.status === 'done' || t.status === 'dismissed')
  // Offer every known repo plus any repo that already has tasks.
  const repoOptions = [...new Set([...repos.map(r => r.workingDir), ...tasks.map(t => t.repo)])].sort((a, b) => repoName(a).localeCompare(repoName(b)))

  const cardProps = { token, busyId, act, onOpenSession, showRepo: !repoFilter }

  return (
    <div className="flex flex-1 flex-col overflow-hidden min-h-0">
      <div className="flex flex-wrap items-center gap-2 border-b border-edge px-4 py-2">
        <label className="flex items-center gap-2 text-meta text-ink-muted">
          <span>Repo</span>
          <select
            aria-label="Filter tasks by repository"
            value={repoFilter}
            onChange={e => { onRepoFilterChange(e.target.value) }}
            className="rounded-control border border-edge bg-page px-2 py-1 text-meta text-ink focus:border-focus focus:outline-none"
          >
            <option value="">All repos</option>
            {repoOptions.map(path => <option key={path} value={path}>{repoName(path)}</option>)}
          </select>
        </label>
        <button type="button" onClick={() => { setDelegating(true) }} className={`${buttonPrimary} ml-auto`}>
          <IconPlus size={14} stroke={2} /> Delegate tasks
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {(error ?? actionError) && <p role="alert" className="mb-3 text-body text-error-5">{actionError ?? error}</p>}

        {data && tasks.length === 0 && (
          <div className="mx-auto mt-10 max-w-md text-center">
            <p className="text-title font-semibold text-ink">No tasks yet</p>
            <p className="mt-2 text-body text-ink-muted">
              Delegate work to {agentName}. It runs each task in its own session, keeps this list up to date, and
              only interrupts you for decisions. Finished work shows up here with a verified pull request.
            </p>
            <button type="button" onClick={() => { setDelegating(true) }} className={`${buttonPrimary} mt-4`}>
              <IconPlus size={14} stroke={2} /> Delegate tasks
            </button>
          </div>
        )}

        {SECTIONS.map(({ status, title }) => {
          const items = byStatus(status)
          if (items.length === 0) return null
          return (
            <section key={status} aria-label={title} className="mb-5">
              <h3 className="mb-2 text-meta font-semibold uppercase tracking-wide text-ink-muted">
                {title} <span className="text-ink-faint">{items.length}</span>
              </h3>
              <ul className="flex flex-col gap-2">
                {items.map(task => (
                  <li key={task.id}>
                    {status === 'needs_decision' ? <DecisionCard task={task} {...cardProps} />
                      : status === 'in_review' ? <ReviewCard task={task} {...cardProps} />
                      : <TaskRow task={task} {...cardProps} />}
                  </li>
                ))}
              </ul>
            </section>
          )
        })}

        {closed.length > 0 && (
          <details className="mb-5">
            <summary className="flex cursor-pointer items-center gap-1 text-meta font-semibold uppercase tracking-wide text-ink-muted">
              <IconChevronRight size={14} stroke={2} /> Done &amp; dismissed <span className="text-ink-faint">{closed.length}</span>
            </summary>
            <ul className="mt-2 flex flex-col gap-2">
              {closed.map(task => <li key={task.id}><TaskRow task={task} {...cardProps} /></li>)}
            </ul>
          </details>
        )}
      </div>

      {delegating && (
        <DelegateTasksDialog
          token={token}
          repos={repoOptions}
          initialRepo={repoFilter}
          agentName={agentName}
          onClose={() => { setDelegating(false) }}
          onDelegated={() => { setDelegating(false); onChanged() }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

interface CardProps {
  task: JoeTask
  token: string
  busyId: string | null
  act: (id: string, action: () => Promise<unknown>) => Promise<void>
  onOpenSession?: (sessionId: string) => void
  showRepo: boolean
}

function TaskHeader({ task, showRepo, onOpenSession }: Pick<CardProps, 'task' | 'showRepo' | 'onOpenSession'>) {
  const childId = task.childId
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className="text-body font-medium text-ink">{task.title}</span>
      {task.priority === 'high' && <span className="rounded-control bg-error-8 px-1.5 text-micro text-error-2">high</span>}
      {task.source !== 'user' && <span className="rounded-control bg-edge-strong px-1.5 text-micro text-ink-muted">{task.source}</span>}
      {showRepo && <span className="text-meta text-ink-faint">{repoName(task.repo)}</span>}
      {childId && onOpenSession && (
        <button
          type="button"
          onClick={() => { onOpenSession(childId) }}
          className="ml-auto inline-flex items-center gap-1 text-meta text-ink-muted hover:text-ink"
          title="Open the session working on this task"
        >
          <IconTerminal2 size={13} stroke={2} /> Session{task.childIds.length > 1 ? ` (attempt ${task.childIds.length})` : ''}
        </button>
      )}
    </div>
  )
}

function DecisionCard({ task, token, busyId, act, onOpenSession, showRepo }: CardProps) {
  const [text, setText] = useState('')
  const decision = task.decision
  const busy = busyId === task.id
  const answer = (value: string) => act(task.id, () => answerDecision(token, task.id, value))
  return (
    <div className="rounded-control border border-warning-7 bg-surface p-3">
      <TaskHeader task={task} showRepo={showRepo} onOpenSession={onOpenSession} />
      {decision ? (
        <>
          <p className="mt-2 text-body text-ink">{decision.question}</p>
          {decision.recommendation && (
            <p className="mt-1 text-meta text-ink-muted">
              {decision.askedBy === 'joe' ? 'Recommendation: ' : 'Note: '}{decision.recommendation}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            {decision.options.map(option => (
              <button key={option} type="button" disabled={busy} onClick={() => { void answer(option) }} className={option === 'Retry' ? buttonPrimary : buttonSecondary}>
                {option === 'Retry' && <IconRefresh size={13} stroke={2} />}{option}
              </button>
            ))}
          </div>
          <form
            className="mt-2 flex gap-2"
            onSubmit={e => { e.preventDefault(); if (text.trim()) void answer(text.trim()).then(() => { setText('') }) }}
          >
            <input
              value={text}
              onChange={e => { setText(e.target.value) }}
              placeholder="Or answer in your own words…"
              aria-label={`Answer for ${task.title}`}
              className="min-w-0 flex-1 rounded-control border border-edge bg-page px-2 py-1 text-meta text-ink placeholder:text-ink-faint focus:border-focus focus:outline-none"
            />
            <button type="submit" disabled={busy || !text.trim()} className={buttonSecondary}>
              <IconMessageCircle size={13} stroke={2} /> Answer
            </button>
          </form>
        </>
      ) : (
        <p className="mt-2 text-meta text-ink-muted">Waiting on you — open the session for details.</p>
      )}
    </div>
  )
}

function ReviewCard({ task, token, busyId, act, onOpenSession, showRepo }: CardProps) {
  const [changing, setChanging] = useState(false)
  const [note, setNote] = useState('')
  const busy = busyId === task.id
  return (
    <div className="rounded-control border border-success-7 bg-surface p-3">
      <TaskHeader task={task} showRepo={showRepo} onOpenSession={onOpenSession} />
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-ink-muted">
        {task.prUrl && (
          <a href={task.prUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary-5 hover:underline">
            Pull request <IconExternalLink size={12} stroke={2} />
          </a>
        )}
        {task.commit && <span className="font-mono">{task.commit.slice(0, 12)}</span>}
        {task.verification && <span>{task.verification.detail}</span>}
      </div>
      {task.acceptance && <p className="mt-1 text-meta text-ink-faint">Done when: {task.acceptance}</p>}
      {changing ? (
        <form
          className="mt-2 flex flex-col gap-2"
          onSubmit={e => { e.preventDefault(); if (note.trim()) void act(task.id, () => requestChanges(token, task.id, note.trim())) }}
        >
          <textarea
            value={note}
            onChange={e => { setNote(e.target.value) }}
            rows={3}
            placeholder="What should change?"
            aria-label={`Requested changes for ${task.title}`}
            className="rounded-control border border-edge bg-page px-2 py-1 text-meta text-ink placeholder:text-ink-faint focus:border-focus focus:outline-none"
          />
          <div className="flex gap-2">
            <button type="submit" disabled={busy || !note.trim()} className={buttonPrimary}>Send back</button>
            <button type="button" onClick={() => { setChanging(false) }} className={buttonSecondary}>Cancel</button>
          </div>
        </form>
      ) : (
        <div className="mt-2 flex gap-2">
          <button type="button" disabled={busy} onClick={() => { void act(task.id, () => acceptTask(token, task.id)) }} className={buttonPrimary}>
            <IconCheck size={13} stroke={2} /> Accept
          </button>
          <button type="button" disabled={busy} onClick={() => { setChanging(true) }} className={buttonSecondary}>Request changes</button>
        </div>
      )}
    </div>
  )
}

function TaskRow({ task, token, busyId, act, onOpenSession, showRepo }: CardProps) {
  const busy = busyId === task.id
  const closed = task.status === 'done' || task.status === 'dismissed'
  return (
    <div className="rounded-control border border-edge bg-surface px-3 py-2">
      <TaskHeader task={task} showRepo={showRepo} onOpenSession={onOpenSession} />
      <div className="mt-1 flex flex-wrap items-center gap-2 text-meta text-ink-muted">
        {task.status === 'in_progress' && <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-accent-5 animate-pulse" />Working</span>}
        {task.status === 'todo' && <span>{task.childIds.length > 0 ? 'Stopped — partial work kept' : 'Not started'}</span>}
        {closed && <span>{task.status === 'done' ? 'Done' : 'Dismissed'}</span>}
        {task.prUrl && closed && (
          <a href={task.prUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary-5 hover:underline">
            PR <IconExternalLink size={12} stroke={2} />
          </a>
        )}
        <span className="ml-auto flex gap-2">
          {closed ? (
            <button type="button" disabled={busy} onClick={() => { void act(task.id, () => setTaskStatus(token, task.id, 'todo')) }} className={buttonSecondary}>Reopen</button>
          ) : task.status === 'todo' ? (
            <>
              <button type="button" disabled={busy} onClick={() => { void act(task.id, () => startTask(token, task.id)) }} className={buttonPrimary}>Start</button>
              <button type="button" disabled={busy} onClick={() => { void act(task.id, () => setTaskStatus(token, task.id, 'dismissed')) }} className={buttonSecondary}>Dismiss</button>
            </>
          ) : null}
        </span>
      </div>
    </div>
  )
}
