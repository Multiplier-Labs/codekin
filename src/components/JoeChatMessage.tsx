/**
 * A message to or from Agent Joe inside a repo session transcript.
 *
 * Attributed so it is never mistaken for the coding agent: "You → Joe" for
 * the user's @Joe requests, Joe's name and avatar for replies. Task
 * milestones carry a task card that reads the live task, so a decision
 * answered in Tasks shows as answered here — and answering here resolves it
 * there.
 */

import { useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { IconRobotFace, IconExternalLink, IconChecklist, IconMessageCircle } from '@tabler/icons-react'
import type { ChatMessage } from '../types'
import { answerDecision, type JoeTask } from '../lib/tasksApi'

type JoeMsg = ChatMessage & { type: 'joe' }

export interface JoeChatContext {
  token: string
  agentName: string
  /** Live tasks linked to the session, by id. */
  tasks: Record<string, JoeTask>
  onTaskChanged?: () => void
  onOpenTasks?: (taskId?: string) => void
}

const STATUS_LABEL: Record<string, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  needs_decision: 'Needs your decision',
  in_review: 'Ready for review',
  done: 'Done',
  dismissed: 'Dismissed',
}

export function JoeChatMessage({ msg, fontSize, ctx, current = true }: {
  msg: JoeMsg
  fontSize: number
  ctx: JoeChatContext
  /** The newest card for its task — the only one with live decision controls. */
  current?: boolean
}) {
  if (msg.role === 'to_joe') {
    return (
      <div className="flex flex-col items-end gap-1">
        <span className="text-micro text-ink-faint">You → Agent {ctx.agentName}</span>
        <div
          className="user-bubble rounded-control border border-accent-7 bg-surface px-3 py-2 text-ink whitespace-pre-wrap"
          style={{ fontSize: `${fontSize}px` }}
        >
          {msg.text}
        </div>
      </div>
    )
  }

  if (msg.notice) {
    return (
      <div className="flex items-center gap-2 text-meta text-ink-muted">
        <IconRobotFace size={14} stroke={2} className="flex-shrink-0 text-accent-5" />
        <span>{msg.text}</span>
      </div>
    )
  }

  const live = msg.task ? ctx.tasks[msg.task.id] : undefined
  return (
    <div className="flex gap-2.5">
      <IconRobotFace size={18} stroke={2} className="mt-0.5 flex-shrink-0 text-accent-5" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 text-micro font-semibold text-accent-4">
          Agent {ctx.agentName}{msg.instruction ? ' → coding agent' : ''}
        </div>
        <div className="prose prose-themed max-w-none text-body" style={{ fontSize: `${fontSize}px` }}>
          <Markdown remarkPlugins={[remarkGfm]}>{msg.text}</Markdown>
        </div>
        {msg.task && <TaskCard snapshot={msg.task} live={live} ctx={ctx} interactive={current} />}
      </div>
    </div>
  )
}

function TaskCard({ snapshot, live, ctx, interactive }: { snapshot: NonNullable<JoeMsg['task']>; live: JoeTask | undefined; ctx: JoeChatContext; interactive: boolean }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const status = live?.status ?? snapshot.status
  const prUrl = live?.prUrl ?? snapshot.prUrl
  // An open decision comes from the live task; a snapshot alone is not
  // proof it is still open (it may have been answered in Tasks).
  const decision = !interactive ? null : live
    ? (live.status === 'needs_decision' && live.decision && live.decision.answer === null ? live.decision : null)
    : snapshot.decision
  const answered = live?.decision?.answer ?? null

  async function answer(value: string) {
    setBusy(true)
    setError(null)
    try {
      await answerDecision(ctx.token, snapshot.id, value)
      setText('')
      ctx.onTaskChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not answer')
      ctx.onTaskChanged?.()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-2 rounded-control border border-edge bg-surface px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <IconChecklist size={14} stroke={2} className="text-ink-muted" />
        <span className="text-body font-medium text-ink">{live?.title ?? snapshot.title}</span>
        <span className="rounded-control bg-edge-strong px-1.5 text-micro text-ink-muted">
          {STATUS_LABEL[status] ?? status}
          {live?.execution === 'running' ? ' · running' : live?.execution === 'queued' ? ' · queued' : ''}
        </span>
        {prUrl && (
          <a href={prUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-meta text-primary-5 hover:underline">
            Pull request <IconExternalLink size={12} stroke={2} />
          </a>
        )}
        {ctx.onOpenTasks && (
          <button type="button" onClick={() => { ctx.onOpenTasks?.(snapshot.id) }} className="ml-auto text-meta text-ink-muted hover:text-ink">
            Open in Tasks
          </button>
        )}
      </div>
      {decision && (
        <div className="mt-2">
          <p className="text-body text-ink">{decision.question}</p>
          {decision.recommendation && <p className="mt-1 text-meta text-ink-muted">Recommendation: {decision.recommendation}</p>}
          {decision.options.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {decision.options.map(option => (
                <button
                  key={option}
                  type="button"
                  disabled={busy}
                  onClick={() => { void answer(option) }}
                  className="rounded-control border border-edge px-2.5 py-1 text-meta text-ink hover:border-edge-strong disabled:opacity-40"
                >
                  {option}
                </button>
              ))}
            </div>
          )}
          <form className="mt-2 flex gap-2" onSubmit={e => { e.preventDefault(); if (text.trim()) void answer(text.trim()) }}>
            <input
              value={text}
              onChange={e => { setText(e.target.value) }}
              placeholder="Or answer in your own words…"
              aria-label={`Answer for ${snapshot.title}`}
              className="min-w-0 flex-1 rounded-control border border-edge bg-page px-2 py-1 text-meta text-ink placeholder:text-ink-faint focus:border-focus focus:outline-none"
            />
            <button type="submit" disabled={busy || !text.trim()} className="inline-flex items-center gap-1 rounded-control border border-edge px-2.5 py-1 text-meta text-ink hover:border-edge-strong disabled:opacity-40">
              <IconMessageCircle size={13} stroke={2} /> Answer
            </button>
          </form>
        </div>
      )}
      {!decision && interactive && answered && snapshot.decision && (
        <p className="mt-1 text-meta text-ink-muted">Answered: {answered}</p>
      )}
      {error && <p role="alert" className="mt-1 text-meta text-error-5">{error}</p>}
    </div>
  )
}
