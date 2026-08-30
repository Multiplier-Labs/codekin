/**
 * Loop run workspace — the detail surface for one run (spec §5.3, Phase 2 cut).
 *
 * Header: recipe, outcome badge, state reason, persistent controls
 * (pause / resume / stop / steer / open session / PR). Two tabs:
 *
 *   Overview — pending intervention cards resolved inline, the current plan,
 *              the evaluator scorecard, budgets, and run facts.
 *   Timeline — the append-only event log (auditable trace), newest last,
 *              streamed via the shared WS ping + gap-fetch on sequence.
 */

import { useState, useEffect } from 'react'
import {
  IconPlayerPause,
  IconPlayerPlay,
  IconSquare,
  IconExternalLink,
  IconMessageForward,
  IconListDetails,
  IconTimeline,
} from '@tabler/icons-react'
import {
  pauseLoopRun,
  resumeLoopRun,
  cancelLoopRun,
  steerLoopRun,
  resolveLoopIntervention,
  getLoopRunEvents,
  getLoopArtifactBody,
  type LoopRunDetail,
  type LoopEvent,
} from '../lib/loopsApi'
import { formatTime } from '../lib/workflowHelpers'
import { stateBadge, ACTIVE_LOOP_STATES } from '../lib/loopHelpers'

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-micro uppercase tracking-wide text-ink-faint">{label}</span>
      <span className="truncate text-body text-ink">{value}</span>
    </div>
  )
}

function BudgetBar({ label, used, total, format }: { label: string; used: number; total: number; format: (n: number) => string }) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0
  return (
    <div className="flex flex-col gap-1">
      <span className="flex justify-between text-meta text-ink-muted">
        <span>{label}</span>
        <span>{format(used)} / {format(total)}</span>
      </span>
      <div className="h-1.5 overflow-hidden rounded-full bg-edge">
        <div className={`h-full rounded-full ${pct >= 90 ? 'bg-error-6' : pct >= 70 ? 'bg-warning-6' : 'bg-accent-6'}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

/** Human labels for event types the timeline shows verbatim otherwise. */
function describeEvent(event: LoopEvent): string {
  const p = (event.payload ?? {}) as Record<string, unknown>
  switch (event.type) {
    case 'run_created': return 'Run created'
    case 'preflight_completed': return `Preflight passed (base ${String(p.baseSha ?? '').slice(0, 10)})`
    case 'maker_started': return p.resumed ? `Maker session restarted (${String(p.phase ?? 'acting')})` : `Maker session started (${String(p.phase ?? 'acting')})`
    case 'maker_turn_completed': return `Maker turn ${String(p.turn)} finished ($${Number(p.costUsd ?? 0).toFixed(2)} total)`
    case 'plan_created': return 'Plan produced'
    case 'evaluation_completed': return String(p.summary ?? `${String(p.evaluatorId)}: ${String(p.status)}`)
    case 'review_started': return `Independent review started (${String(p.provider)})`
    case 'review_verdict': return `Review verdict: ${String(p.verdict ?? 'unparseable')}${p.reason ? ` — ${String(p.reason)}` : ''}`
    case 'protected_path_violation': return `Protected path touched: ${(p.files as string[] | undefined)?.join(', ') ?? ''}`
    case 'budget_boundary': return `Budget boundary: ${String(p.reason)}`
    case 'budget_extended': return 'Budget extended by the operator'
    case 'wall_time_exceeded': return 'Wall-time budget exceeded'
    case 'intervention_created': return `Needs a decision: ${String(p.title ?? p.purpose)}`
    case 'intervention_resolved': return `Decision: ${String(p.choice)}${p.note ? ` — ${String(p.note)}` : ''}`
    case 'session_blocked': return `Session waiting on ${String(p.toolName ?? 'a prompt')}`
    case 'steer_received': return `Steer: ${String(p.instruction)}`
    case 'pause_requested': return 'Pause requested'
    case 'paused': return 'Paused'
    case 'resumed': return 'Resumed'
    case 'cancel_requested': return 'Stop requested'
    case 'state_changed': return `→ ${String(p.state)}${p.reason ? ` (${String(p.reason)})` : ''}`
    case 'finalized': return String(p.note ?? 'Finalized')
    case 'run_completed': return `Run ${String(p.outcome)}: ${String(p.reason ?? '')}`
    case 'recovery_started': return `Recovering after a restart (was ${String(p.fromState)})`
    default: return event.type
  }
}

const NOISY_EVENTS = new Set(['state_changed'])

interface Props {
  token: string
  detail: LoopRunDetail
  onAct: (fn: () => Promise<void>) => Promise<void>
  onNavigateToSession?: (sessionId: string) => void
}

export function LoopRunWorkspace({ token, detail, onAct, onNavigateToSession }: Props) {
  const [tab, setTab] = useState<'overview' | 'timeline'>('overview')
  const [steerText, setSteerText] = useState('')
  const [steerRevisePlan, setSteerRevisePlan] = useState(false)
  const [noteById, setNoteById] = useState<Record<string, string>>({})
  const [planText, setPlanText] = useState<string | null>(null)
  const [events, setEvents] = useState<LoopEvent[]>([])
  const [showNoise, setShowNoise] = useState(false)

  const badge = stateBadge(detail)
  const pending = detail.interventions.filter((iv) => iv.status === 'pending')
  const active = ACTIVE_LOOP_STATES.has(detail.state)
  const planArtifact = detail.artifacts.filter((a) => a.kind === 'plan').at(-1)

  useEffect(() => {
    if (!planArtifact) return
    let cancelled = false
    getLoopArtifactBody(token, detail.id, planArtifact.id)
      .then((text) => { if (!cancelled) setPlanText(text) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [token, detail.id, planArtifact?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Timeline: fetch the gap whenever the run's cursor moves past what we hold.
  useEffect(() => {
    if (tab !== 'timeline') return
    let cancelled = false
    const have = events.length ? events[events.length - 1].sequence : 0
    if (detail.lastSequence <= have) return
    getLoopRunEvents(token, detail.id, have)
      .then(({ events: fresh }) => {
        if (cancelled) return
        setEvents((prev) => [...prev, ...fresh.filter((e) => e.sequence > (prev.at(-1)?.sequence ?? 0))])
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [tab, token, detail.id, detail.lastSequence]) // eslint-disable-line react-hooks/exhaustive-deps

  const budgets = detail.recipe.budgets

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-edge p-4 pb-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-title text-ink">{detail.recipeId}</h2>
            <p className="mt-0.5 line-clamp-2 text-meta text-ink-muted">{detail.goal.split('\n')[0]}</p>
          </div>
          <span className={`inline-flex flex-shrink-0 items-center rounded-control px-2 py-1 text-meta font-medium ${badge.classes}`}>
            {badge.label}
          </span>
        </div>
        {detail.stateReason && <p className="mt-1 text-meta text-warning-3">{detail.stateReason}</p>}

        <div className="mt-2 flex flex-wrap items-center gap-2">
          {active && (
            <button onClick={() => { void onAct(() => pauseLoopRun(token, detail.id)) }} className="flex items-center gap-1 rounded-control border border-edge px-2 py-1 text-meta text-ink hover:bg-surface-raised transition-colors">
              <IconPlayerPause size={13} stroke={2} /> Pause
            </button>
          )}
          {detail.state === 'paused' && (
            <button onClick={() => { void onAct(() => resumeLoopRun(token, detail.id)) }} className="flex items-center gap-1 rounded-control border border-edge px-2 py-1 text-meta text-ink hover:bg-surface-raised transition-colors">
              <IconPlayerPlay size={13} stroke={2} /> Resume
            </button>
          )}
          {detail.state !== 'done' && (
            <button onClick={() => { void onAct(() => cancelLoopRun(token, detail.id)) }} className="flex items-center gap-1 rounded-control border border-error-8 px-2 py-1 text-meta text-error-3 hover:bg-error-10/40 transition-colors">
              <IconSquare size={13} stroke={2} /> Stop
            </button>
          )}
          {detail.makerSessionId != null && onNavigateToSession && (
            <button
              onClick={() => { if (detail.makerSessionId != null) onNavigateToSession(detail.makerSessionId) }}
              className="flex items-center gap-1 rounded-control border border-edge px-2 py-1 text-meta text-ink-muted hover:bg-surface-raised transition-colors"
            >
              <IconExternalLink size={13} stroke={2} /> Open session
            </button>
          )}
          {detail.prUrl && (
            <a href={detail.prUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 rounded-control border border-edge px-2 py-1 text-meta text-primary-4 hover:text-primary-3 transition-colors">
              PR <IconExternalLink size={13} stroke={2} />
            </a>
          )}
          <div className="flex-1" />
          <div className="flex gap-1">
            {([['overview', IconListDetails], ['timeline', IconTimeline]] as const).map(([id, Icon]) => (
              <button
                key={id}
                onClick={() => { setTab(id) }}
                className={`flex items-center gap-1 rounded-control px-2 py-1 text-meta capitalize transition-colors ${
                  tab === id ? 'bg-accent-9/30 text-accent-2' : 'text-ink-muted hover:bg-surface-raised hover:text-ink'
                }`}
              >
                <Icon size={13} stroke={2} /> {id}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'overview' ? (
          <div className="flex flex-col gap-4 p-4">
            {/* Intervention cards */}
            {pending.map((iv) => (
              <div key={iv.id} className="rounded-control border border-warning-9/60 bg-warning-10/40 p-3">
                <p className="text-body font-medium text-warning-1">{iv.title}</p>
                {iv.body && <pre className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap font-sans text-meta text-warning-2">{iv.body}</pre>}
                <input
                  value={noteById[iv.id] ?? ''}
                  onChange={(e) => { setNoteById((m) => ({ ...m, [iv.id]: e.target.value })) }}
                  placeholder="Optional note / guidance"
                  className="mt-2 w-full rounded-control border border-edge bg-surface px-2 py-1 text-meta text-ink placeholder:text-ink-faint focus:border-focus focus:outline-none"
                />
                <div className="mt-2 flex gap-2">
                  {iv.options.map((option) => (
                    <button
                      key={option}
                      onClick={() => { void onAct(() => resolveLoopIntervention(token, detail.id, iv.id, option, (noteById[iv.id] ?? '').trim() || undefined)) }}
                      className="rounded-control border border-edge px-2.5 py-1 text-meta font-medium capitalize text-ink hover:bg-surface-raised transition-colors"
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </div>
            ))}

            {/* Steer */}
            {detail.state !== 'done' && (
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  const text = steerText.trim()
                  if (!text) return
                  setSteerText('')
                  void onAct(() => steerLoopRun(token, detail.id, text, steerRevisePlan))
                }}
              >
                <input
                  value={steerText}
                  onChange={(e) => { setSteerText(e.target.value) }}
                  placeholder="Steer the run — delivered at the next safe boundary"
                  className="flex-1 rounded-control border border-edge bg-surface px-2 py-1 text-body text-ink placeholder:text-ink-faint focus:border-focus focus:outline-none"
                />
                <label className="flex flex-shrink-0 items-center gap-1 text-meta text-ink-muted">
                  <input type="checkbox" checked={steerRevisePlan} onChange={(e) => { setSteerRevisePlan(e.target.checked) }} className="accent-current" />
                  revise plan first
                </label>
                <button type="submit" className="flex items-center gap-1 rounded-control border border-edge px-2 py-1 text-meta text-ink hover:bg-surface-raised transition-colors">
                  <IconMessageForward size={13} stroke={2} /> Send
                </button>
              </form>
            )}

            {/* Budgets */}
            {budgets && (
              <div className="grid grid-cols-2 gap-3">
                <BudgetBar label="Turns" used={detail.turnCount} total={budgets.turns} format={(n) => String(Math.round(n))} />
                <BudgetBar label="Cost" used={detail.costUsd} total={budgets.costUsd} format={(n) => `$${n.toFixed(2)}`} />
              </div>
            )}

            {/* Plan */}
            {planText && (
              <div>
                <h3 className="mb-1 text-meta font-medium text-ink-muted">Plan</h3>
                <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-control border border-edge p-3 font-sans text-meta text-ink">{planText}</pre>
              </div>
            )}

            {/* Evaluations scorecard */}
            {detail.evaluations.length > 0 && (
              <div>
                <h3 className="mb-1 text-meta font-medium text-ink-muted">Evaluations</h3>
                <ul className="divide-y divide-edge rounded-control border border-edge">
                  {detail.evaluations.slice(-12).map((ev) => (
                    <li key={ev.id} className="flex items-center gap-2 px-2.5 py-1.5">
                      <span
                        className={`inline-flex w-14 flex-shrink-0 justify-center rounded-control px-1 py-0.5 text-micro font-medium ${
                          ev.status === 'pass' ? 'bg-success-7 text-success-2' : ev.status === 'error' ? 'bg-warning-8 text-warning-2' : 'bg-error-8 text-error-2'
                        }`}
                      >
                        {ev.status}
                      </span>
                      <span className="truncate text-meta text-ink">{ev.summary}</span>
                      <span className="ml-auto flex-shrink-0 text-micro text-ink-faint">{formatTime(ev.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Facts */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Meta label="Branch" value={detail.baseBranch ? `${detail.branch} ← ${detail.baseBranch}` : detail.branch} />
              <Meta label="Provider" value={detail.model ? `${detail.provider} (${detail.model})` : detail.provider} />
              <Meta label="Started" value={formatTime(detail.startedAt)} />
              <Meta label="Recipe hash" value={detail.recipeHash.slice(0, 12)} />
            </div>

            {/* Stage history */}
            {detail.stages.length > 0 && (
              <div>
                <h3 className="mb-1 text-meta font-medium text-ink-muted">Stages</h3>
                <ol className="flex flex-wrap gap-1.5">
                  {detail.stages.map((stage) => (
                    <li
                      key={stage.id}
                      className={`rounded-control border px-2 py-0.5 text-micro ${
                        stage.status === 'succeeded'
                          ? 'border-success-8 text-success-3'
                          : stage.status === 'failed'
                            ? 'border-error-8 text-error-3'
                            : stage.status === 'running'
                              ? 'border-accent-8 text-accent-3'
                              : 'border-edge text-ink-muted'
                      }`}
                    >
                      {stage.stageIndex}. {stage.kind}
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col p-4">
            <label className="mb-2 flex items-center gap-1.5 self-end text-meta text-ink-muted">
              <input type="checkbox" checked={showNoise} onChange={(e) => { setShowNoise(e.target.checked) }} className="accent-current" />
              show state transitions
            </label>
            <ol className="flex flex-col">
              {events
                .filter((e) => showNoise || !NOISY_EVENTS.has(e.type))
                .map((event) => (
                  <li key={event.sequence} className="flex gap-2 border-l-2 border-edge py-1 pl-3">
                    <span className="w-14 flex-shrink-0 text-micro text-ink-faint">#{event.sequence}</span>
                    <span className="min-w-0 flex-1 break-words text-meta text-ink">{describeEvent(event)}</span>
                    <span className="flex-shrink-0 text-micro text-ink-faint">
                      {event.actor.type === 'user' ? 'you · ' : event.actor.id ? `${event.actor.id} · ` : ''}
                      {formatTime(event.at)}
                    </span>
                  </li>
                ))}
              {events.length === 0 && <li className="py-6 text-center text-meta text-ink-muted">Loading events…</li>}
            </ol>
          </div>
        )}
      </div>
    </div>
  )
}
