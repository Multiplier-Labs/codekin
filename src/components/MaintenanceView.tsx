/**
 * A repo's maintenance view (docs/JOE-REPO-COLLABORATION-MAINTENANCE-SPEC.md §6–§9).
 *
 * Answers three questions: what is Joe watching (responsibilities and their
 * checks, with last success, next run and health), what is Joe doing (open
 * maintenance tasks), and what happened (activity, including clean checks).
 * Enabling is an explicit review: responsibilities — Joe's proposals
 * included — policies, limits, and which automations pause with the plan.
 */

import { useCallback, useEffect, useState } from 'react'
import { IconHeartbeat, IconArrowLeft, IconPlus, IconTrash, IconExternalLink } from '@tabler/icons-react'
import {
  POLICY_LABELS, addResponsibility, getMaintenancePlan, releaseAutomation, removeResponsibility, setPlanState,
  type MaintenanceActivity, type RepoMaintenance, type Responsibility, type ResponsePolicy, type ResponsibilityCheck,
} from '../lib/maintenanceApi'
import { getConfig, type ReviewRepoConfig } from '../lib/workflowApi'
import { listTasks, repoName, type JoeTask } from '../lib/tasksApi'
import { subscribeWorkflowEvents } from '../lib/workflowEvents'
import { sectionOf } from '../lib/taskSections'

interface Props {
  token: string
  repo: string
  agentName: string
  onBack: () => void
  onOpenTasks: () => void
  onOpenSession: (sessionId: string) => void
  onOpenAutomations: () => void
  /** Called after any change so the nav indicator refreshes. */
  onChanged: () => void
}

const buttonSecondary = 'inline-flex items-center gap-1 rounded-control border border-edge px-2.5 py-1 text-meta text-ink hover:border-edge-strong disabled:opacity-40'
const buttonPrimary = 'inline-flex items-center gap-1 rounded-control bg-primary-8 px-2.5 py-1 text-meta font-medium text-on-primary hover:bg-primary-7 disabled:opacity-40'
const inputClass = 'rounded-control border border-edge bg-page px-2 py-1 text-meta text-ink placeholder:text-ink-faint focus:border-focus focus:outline-none'

const CHECK_HEALTH_LABEL: Record<ResponsibilityCheck['health'], string> = {
  healthy: 'Healthy',
  starting: 'No result yet',
  held: 'Held',
  degraded: 'Needs attention',
  unavailable: 'Unavailable',
  disabled: 'Disabled',
  missing: 'Removed',
}

function healthTone(health: string | null): string {
  if (health === 'healthy') return 'text-success-5'
  if (health === 'starting' || health === null) return 'text-ink-muted'
  return 'text-warning-5'
}

function when(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function MaintenanceView({ token, repo, agentName, onBack, onOpenTasks, onOpenSession, onOpenAutomations, onChanged }: Props) {
  const [plan, setPlan] = useState<RepoMaintenance | null>(null)
  const [activity, setActivity] = useState<MaintenanceActivity[]>([])
  const [automations, setAutomations] = useState<ReviewRepoConfig[]>([])
  const [tasks, setTasks] = useState<JoeTask[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [adopt, setAdopt] = useState<Record<string, boolean>>({})
  const [adding, setAdding] = useState(false)

  const load = useCallback(async () => {
    try {
      const [planResult, config, taskList] = await Promise.all([
        getMaintenancePlan(token, repo),
        getConfig(token),
        listTasks(token, { repo }),
      ])
      setPlan(planResult.plan)
      setActivity(planResult.activity)
      setAutomations(config.reviewRepos.filter(r => r.repoPath === repo))
      setTasks(taskList.tasks.filter(t => t.responsibilityId && t.status !== 'done' && t.status !== 'dismissed'))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load maintenance')
    }
  }, [token, repo])

  useEffect(() => {
    void load() // eslint-disable-line react-hooks/set-state-in-effect -- initial load
    let debounce: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = subscribeWorkflowEvents(() => {
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => { void load() }, 800)
    })
    return () => {
      if (debounce) clearTimeout(debounce)
      unsubscribe()
    }
  }, [load])

  async function act(action: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await action()
      await load()
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setBusy(false)
    }
  }

  const responsibilities = plan?.responsibilities ?? []
  const linkedIds = [...new Set(responsibilities.flatMap(r => r.automationIds))]
  const automationName = (id: string) => automations.find(a => a.id === id)?.name ?? id

  function startReview() {
    // Default: every linked automation pauses with the plan unless the user opts out.
    setAdopt(Object.fromEntries(linkedIds.map(id => [id, true])))
    setReviewing(true)
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden min-h-0">
      <div className="flex flex-wrap items-center gap-3 border-b border-edge px-4 py-2.5">
        <button type="button" onClick={onBack} className="inline-flex items-center gap-1 rounded-control px-1.5 py-1 text-meta text-ink-muted hover:bg-surface-raised hover:text-ink">
          <IconArrowLeft size={14} stroke={2} /> Tasks
        </button>
        <IconHeartbeat size={18} stroke={2} className="text-accent-5" />
        <h1 className="text-title font-semibold text-ink">{repoName(repo)}</h1>
        {plan && <span className={`text-meta font-medium ${plan.state === 'enabled' ? healthTone(plan.health) : 'text-ink-muted'}`}>{plan.label.replace(/^Joe\b/, agentName)}</span>}
        <span className="ml-auto flex flex-wrap gap-2">
          {plan?.state === 'off' && (
            <button type="button" disabled={busy || responsibilities.length === 0} onClick={startReview} className={buttonPrimary} title={responsibilities.length === 0 ? 'Add a responsibility first' : undefined}>
              Review &amp; enable
            </button>
          )}
          {plan?.state === 'enabled' && (
            <button type="button" disabled={busy} onClick={() => { void act(() => setPlanState(token, 'pause', repo, { expectedRevision: plan.revision })) }} className={buttonSecondary}>Pause</button>
          )}
          {plan?.state === 'paused' && (
            <button type="button" disabled={busy} onClick={() => { void act(() => setPlanState(token, 'resume', repo, { expectedRevision: plan.revision })) }} className={buttonPrimary}>Resume</button>
          )}
          {plan && plan.state !== 'off' && (
            <button type="button" disabled={busy} onClick={() => { void act(() => setPlanState(token, 'off', repo, { expectedRevision: plan.revision })) }} className={buttonSecondary}>Turn off</button>
          )}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {error && <p role="alert" className="mb-3 text-body text-error-5">{error}</p>}

        {plan?.state === 'off' && (
          <p className="mb-4 max-w-2xl text-body text-ink-muted">
            {agentName} does not maintain this repo. Tasks you ask for still run. To have {agentName} watch it, add
            responsibilities linked to its automations{plan.hasProposal ? ` (or review ${agentName}'s proposal below)` : ''}, then review and enable.
          </p>
        )}
        {plan?.state === 'paused' && (
          <p className="mb-4 max-w-2xl text-body text-ink-muted">
            Paused: governed checks and new maintenance work are on hold{plan.runningTasks > 0 ? `; ${plan.runningTasks} running task${plan.runningTasks === 1 ? '' : 's'} will finish` : ''}. Resuming reconciles current conditions without duplicating tasks.
          </p>
        )}
        {plan?.state === 'enabled' && plan.reasons.length > 0 && (
          <ul className={`mb-4 flex flex-col gap-1 text-meta ${healthTone(plan.health)}`}>
            {plan.reasons.map(r => <li key={r}>{r}</li>)}
          </ul>
        )}

        {reviewing && plan && (
          <EnableReview
            plan={plan}
            adopt={adopt}
            onAdoptChange={(id, value) => { setAdopt(prev => ({ ...prev, [id]: value })) }}
            automationName={automationName}
            busy={busy}
            agentName={agentName}
            onCancel={() => { setReviewing(false) }}
            onEnable={() => {
              void act(() => setPlanState(token, 'enable', repo, {
                expectedRevision: plan.revision,
                adoptAutomationIds: Object.entries(adopt).filter(([, v]) => v).map(([id]) => id),
              })).then(() => { setReviewing(false) })
            }}
          />
        )}

        <section aria-label="What is being watched" className="mb-6">
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-meta font-semibold uppercase tracking-wide text-ink-muted">Responsibilities &amp; monitoring</h2>
            <button type="button" onClick={() => { setAdding(v => !v) }} className={`${buttonSecondary} ml-auto`}>
              <IconPlus size={13} stroke={2} /> Add responsibility
            </button>
          </div>
          {adding && (
            <ResponsibilityForm
              automations={automations}
              busy={busy}
              onOpenAutomations={onOpenAutomations}
              onCancel={() => { setAdding(false) }}
              onSubmit={(input) => { void act(() => addResponsibility(token, { repo, ...input })).then(() => { setAdding(false) }) }}
            />
          )}
          {responsibilities.length === 0 && !adding && <p className="text-body text-ink-muted">No responsibilities yet.</p>}
          <ul className="flex flex-col gap-2">
            {responsibilities.map(r => (
              <li key={r.id}>
                <ResponsibilityCard
                  r={r}
                  planEnabled={plan?.state === 'enabled'}
                  agentName={agentName}
                  busy={busy}
                  onRemove={() => { void act(() => removeResponsibility(token, r.id)) }}
                />
              </li>
            ))}
          </ul>
        </section>

        {plan && plan.governedAutomations.length > 0 && (
          <section aria-label="Automations managed by maintenance" className="mb-6">
            <h2 className="mb-2 text-meta font-semibold uppercase tracking-wide text-ink-muted">Managed by maintenance</h2>
            <p className="mb-2 text-meta text-ink-muted">These run only while maintenance is enabled. Linked automations not listed here keep their own controls.</p>
            <ul className="flex flex-col gap-1">
              {plan.governedAutomations.map(id => (
                <li key={id} className="flex items-center gap-2 text-body text-ink">
                  <span>{automationName(id)}</span>
                  <button type="button" disabled={busy} onClick={() => { void act(() => releaseAutomation(token, id)) }} className={`${buttonSecondary} ml-auto`}>
                    Run independently
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section aria-label="What Joe is doing" className="mb-6">
          <h2 className="mb-2 text-meta font-semibold uppercase tracking-wide text-ink-muted">Current actions</h2>
          {tasks.length === 0 ? <p className="text-body text-ink-muted">No open maintenance tasks.</p> : (
            <ul className="flex flex-col gap-1.5">
              {tasks.map(t => {
                const why = responsibilities.find(r => r.id === t.responsibilityId)?.name
                return (
                  <li key={t.id} className="flex flex-wrap items-center gap-2 rounded-control border border-edge bg-surface px-3 py-2 text-body">
                    <span className="font-medium text-ink">{t.title}</span>
                    <span className="text-meta text-ink-muted">{sectionOf(t) ?? t.status}{why ? ` · ${why}` : ''}</span>
                    {t.childId && (
                      <button type="button" onClick={() => { if (t.childId) onOpenSession(t.childId) }} className="ml-auto text-meta text-ink-muted hover:text-ink">Session</button>
                    )}
                    {t.prUrl && <a href={t.prUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-meta text-primary-5">PR <IconExternalLink size={12} stroke={2} /></a>}
                  </li>
                )
              })}
            </ul>
          )}
          <button type="button" onClick={onOpenTasks} className="mt-2 text-meta text-ink-muted hover:text-ink">All tasks for this repo →</button>
        </section>

        <section aria-label="What happened" className="mb-6">
          <h2 className="mb-2 text-meta font-semibold uppercase tracking-wide text-ink-muted">Recent activity</h2>
          {activity.length === 0 ? <p className="text-body text-ink-muted">Nothing yet.</p> : (
            <ul className="flex flex-col gap-1">
              {activity.map(a => (
                <li key={a.id} className="flex gap-3 text-meta">
                  <span className="w-28 flex-shrink-0 text-ink-faint">{when(a.createdAt)}</span>
                  <span className={a.kind === 'check_failed' || a.kind === 'coverage' ? 'text-warning-5' : a.kind === 'finding' ? 'text-ink' : 'text-ink-muted'}>{a.summary}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-label="Permissions" className="mb-6">
          <h2 className="mb-2 text-meta font-semibold uppercase tracking-wide text-ink-muted">Permissions</h2>
          <ul className="flex flex-col gap-1 text-meta text-ink-muted">
            {responsibilities.filter(r => !r.proposed).map(r => (
              <li key={r.id}>
                <span className="text-ink">{r.name}:</span> {POLICY_LABELS[r.policy].description}, at most {r.maxActiveTasks} open task{r.maxActiveTasks === 1 ? '' : 's'}.
                {r.requiredDecision && <> Always asks before: {r.requiredDecision}.</>}
              </li>
            ))}
            <li>Maintenance never merges, deploys or operates the host, and stays within the repo's permissions.</li>
          </ul>
        </section>
      </div>
    </div>
  )
}

function ResponsibilityCard({ r, planEnabled, agentName, busy, onRemove }: {
  r: Responsibility; planEnabled: boolean; agentName: string; busy: boolean; onRemove: () => void
}) {
  return (
    <div className={`rounded-control border bg-surface px-3 py-2 ${r.proposed ? 'border-accent-7 border-dashed' : 'border-edge'}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-body font-medium text-ink">{r.name}</span>
        {r.proposed && <span className="rounded-control bg-accent-9/40 px-1.5 text-micro text-accent-3">Proposed by {agentName}</span>}
        <span className="rounded-control bg-edge-strong px-1.5 text-micro text-ink-muted">{POLICY_LABELS[r.policy].label}</span>
        {planEnabled && !r.proposed && r.health && <span className={`text-meta ${healthTone(r.health)}`}>{r.health === 'healthy' ? 'Healthy' : r.health === 'starting' ? 'Starting' : r.health === 'unavailable' ? 'Unavailable' : 'Needs attention'}</span>}
        <button type="button" disabled={busy} onClick={onRemove} className="ml-auto rounded-control p-1 text-ink-faint hover:text-error-5" title="Remove responsibility" aria-label={`Remove ${r.name}`}>
          <IconTrash size={14} stroke={2} />
        </button>
      </div>
      {r.scope && <p className="mt-0.5 text-meta text-ink-muted">Scope: {r.scope}</p>}
      <table className="mt-2 w-full text-meta">
        <thead>
          <tr className="text-left text-ink-faint">
            <th className="font-normal">Check</th><th className="font-normal">Status</th><th className="font-normal">Last success</th><th className="font-normal">Next</th>
          </tr>
        </thead>
        <tbody>
          {r.checks.map(c => (
            <tr key={c.automationId} className="text-ink">
              <td>{c.name ?? c.automationId}{c.managedBy === 'maintenance' ? ' · managed' : ''}</td>
              <td className={healthTone(c.health === 'held' || c.health === 'disabled' || c.health === 'missing' ? 'degraded' : c.health)} title={c.hold?.reason}>
                {CHECK_HEALTH_LABEL[c.health]}{c.hold ? ` — ${c.hold.reason}` : ''}
              </td>
              <td>{when(c.lastSuccessAt)}</td>
              <td>{when(c.nextRunAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {r.latestObservation && <p className="mt-2 text-meta text-ink-muted">Latest: {r.latestObservation} <span className="text-ink-faint">({when(r.latestObservationAt)})</span></p>}
    </div>
  )
}

function ResponsibilityForm({ automations, busy, onSubmit, onCancel, onOpenAutomations }: {
  automations: ReviewRepoConfig[]
  busy: boolean
  onSubmit: (input: { name: string; scope: string; automationIds: string[]; policy: ResponsePolicy; maxActiveTasks: number; requiredDecision: string }) => void
  onCancel: () => void
  onOpenAutomations: () => void
}) {
  const [name, setName] = useState('')
  const [scope, setScope] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [policy, setPolicy] = useState<ResponsePolicy>('propose')
  const [maxActiveTasks, setMaxActiveTasks] = useState(1)
  const [requiredDecision, setRequiredDecision] = useState('')

  if (automations.length === 0) {
    return (
      <div className="mb-3 rounded-control border border-edge bg-surface px-3 py-2 text-body text-ink-muted">
        Responsibilities are covered by this repo's automations, and it has none yet.{' '}
        <button type="button" onClick={onOpenAutomations} className="text-primary-5 hover:underline">Add one in Automations</button>, or ask Joe in a session.
      </div>
    )
  }

  return (
    <form
      className="mb-3 flex flex-col gap-2 rounded-control border border-edge bg-surface px-3 py-2"
      onSubmit={e => { e.preventDefault(); if (name.trim() && picked.length) onSubmit({ name: name.trim(), scope, automationIds: picked, policy, maxActiveTasks, requiredDecision }) }}
    >
      <input value={name} onChange={e => { setName(e.target.value) }} placeholder="Responsibility, e.g. Keep dependencies healthy" aria-label="Responsibility name" className={inputClass} />
      <input value={scope} onChange={e => { setScope(e.target.value) }} placeholder="Scope (optional), e.g. package.json on main" aria-label="Scope" className={inputClass} />
      <fieldset className="flex flex-col gap-1">
        <legend className="text-meta text-ink-muted">Checks (automations)</legend>
        {automations.map(a => (
          <label key={a.id} className="flex items-center gap-2 text-meta text-ink">
            <input
              type="checkbox"
              checked={picked.includes(a.id)}
              onChange={e => { setPicked(prev => e.target.checked ? [...prev, a.id] : prev.filter(id => id !== a.id)) }}
            />
            {a.name} <span className="text-ink-faint">{a.cronExpression === 'event' ? 'on event' : a.cronExpression}{a.enabled ? '' : ' · disabled'}</span>
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-meta text-ink-muted">
          Response
          <select value={policy} onChange={e => { setPolicy(e.target.value as ResponsePolicy) }} className={inputClass} aria-label="Response policy">
            {(Object.keys(POLICY_LABELS) as ResponsePolicy[]).map(p => <option key={p} value={p}>{POLICY_LABELS[p].label} — {POLICY_LABELS[p].description}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-meta text-ink-muted">
          Open tasks at most
          <input type="number" min={1} max={10} value={maxActiveTasks} onChange={e => { setMaxActiveTasks(Math.min(10, Math.max(1, Number(e.target.value) || 1))) }} className={`${inputClass} w-14`} aria-label="Task limit" />
        </label>
      </div>
      <input value={requiredDecision} onChange={e => { setRequiredDecision(e.target.value) }} placeholder="Always ask before… (optional)" aria-label="Required decision" className={inputClass} />
      <div className="flex gap-2">
        <button type="submit" disabled={busy || !name.trim() || picked.length === 0} className={buttonPrimary}>Add</button>
        <button type="button" onClick={onCancel} className={buttonSecondary}>Cancel</button>
      </div>
    </form>
  )
}

function EnableReview({ plan, adopt, onAdoptChange, automationName, busy, agentName, onCancel, onEnable }: {
  plan: RepoMaintenance
  adopt: Record<string, boolean>
  onAdoptChange: (id: string, value: boolean) => void
  automationName: (id: string) => string
  busy: boolean
  agentName: string
  onCancel: () => void
  onEnable: () => void
}) {
  const enabled = plan.responsibilities.filter(r => r.enabled)
  return (
    <div role="dialog" aria-label="Review maintenance" className="mb-5 rounded-floating border border-edge-strong bg-surface-raised px-4 py-3 shadow-floating">
      <h2 className="text-title font-semibold text-ink">Review {agentName}'s mandate for {repoName(plan.repo)}</h2>
      <ul className="mt-2 flex flex-col gap-1.5 text-body text-ink">
        {enabled.map(r => (
          <li key={r.id}>
            <span className="font-medium">{r.name}</span>{r.proposed ? ` (proposed by ${agentName})` : ''} — {POLICY_LABELS[r.policy].description.toLowerCase()}, at most {r.maxActiveTasks} open task{r.maxActiveTasks === 1 ? '' : 's'}
            {r.requiredDecision && `; always asks before ${r.requiredDecision}`}.
          </li>
        ))}
      </ul>
      <p className="mt-3 text-meta text-ink-muted">Checked automations pause and resume with maintenance. Unchecked ones keep running on their own controls.</p>
      <ul className="mt-1 flex flex-col gap-1">
        {Object.keys(adopt).map(id => (
          <li key={id}>
            <label className="flex items-center gap-2 text-meta text-ink">
              <input type="checkbox" checked={adopt[id]} onChange={e => { onAdoptChange(id, e.target.checked) }} />
              {automationName(id)}
            </label>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex gap-2">
        <button type="button" disabled={busy} onClick={onEnable} className={buttonPrimary}>Enable maintenance</button>
        <button type="button" onClick={onCancel} className={buttonSecondary}>Cancel</button>
      </div>
    </div>
  )
}
