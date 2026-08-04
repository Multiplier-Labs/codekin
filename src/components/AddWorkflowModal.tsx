/**
 * Multi-step wizard for creating a new workflow.
 *
 * Steps:
 *   1. Select repository
 *   2. Select workflow type
 *   3. Configure schedule (or model/focus for event-driven workflows)
 */

import { useState, useEffect } from 'react'
import { IconX, IconLoader2, IconArrowLeft, IconArrowRight, IconCheck, IconAlertTriangle } from '@tabler/icons-react'
import { useRepos } from '../hooks/useRepos'
import { listKinds } from '../lib/workflowApi'
import type { ReviewRepoConfig, WorkflowKindInfo, WebhookSetupResult } from '../lib/workflowApi'
import {
  WORKFLOW_KINDS, DAY_PRESETS, DAY_INDIVIDUAL,
  buildCron, describeCron, slugify, kindCategory,
  isBiweeklyDow, isEventDriven, EVENT_CRON,
} from '../lib/workflowHelpers'
import type { CodingProvider } from '../types'
import { CategoryBadge } from './WorkflowBadges'
import TimePicker from './TimePicker'
import { RepoList } from './RepoList'
import { ProviderModelSection } from './workflows/ProviderModelSection'

type Step = 1 | 2 | 3

interface FormState {
  kind: string
  repoPath: string
  repoName: string
  cronHour: number
  cronMinute: number
  cronDow: string
  customPrompt: string
  model: string
  provider: CodingProvider
}

interface Props {
  token: string
  onClose: () => void
  onAdd: (repo: ReviewRepoConfig, webhookUrl?: string) => Promise<WebhookSetupResult | undefined>
}

// ---------------------------------------------------------------------------
// Step indicator
// ---------------------------------------------------------------------------

function StepIndicator({ current, eventDriven }: { current: Step; eventDriven: boolean }) {
  const steps = [
    { num: 1 as const, label: 'Repository' },
    { num: 2 as const, label: 'Workflow' },
    { num: 3 as const, label: eventDriven ? 'Configure' : 'Schedule' },
  ]

  return (
    <div className="flex items-center gap-1 mb-5">
      {steps.map((s, i) => (
        <div key={s.num} className="flex items-center gap-1 flex-1">
          <div className="flex items-center gap-2 flex-1">
            <span className={`w-6 h-6 rounded-full flex items-center justify-center text-meta font-semibold shrink-0 ${
              s.num < current
                ? 'bg-success-7 text-ink-inverse'
                : s.num === current
                  ? 'bg-accent-7 text-ink-inverse'
                  : 'bg-edge text-ink-muted'
            }`}>
              {s.num < current ? <IconCheck size={12} stroke={3} /> : s.num}
            </span>
            <span className={`text-body font-medium ${
              s.num === current ? 'text-ink' : 'text-ink-muted'
            }`}>
              {s.label}
            </span>
          </div>
          {i < steps.length - 1 && (
            <div className={`h-px flex-1 mx-1 ${s.num < current ? 'bg-success-7' : 'bg-edge-strong'}`} />
          )}
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 1: Repository selection
// ---------------------------------------------------------------------------

function StepRepo({
  token,
  selectedRepoId,
  onSelect,
}: {
  token: string
  selectedRepoId: string
  onSelect: (repoId: string, repoPath: string, repoName: string) => void
}) {
  const { groups, loading, error } = useRepos(token)
  const allRepos = groups.flatMap(g => g.repos)

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-8 justify-center text-body text-ink-muted">
        <IconLoader2 size={16} stroke={2} className="animate-spin" />
        Loading repositories…
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-control bg-error-10/50 px-3 py-2 text-body text-error-4">
        Failed to load repos: {error}
      </div>
    )
  }

  return (
    <div>
      <p className="text-body text-ink-muted mb-3">
        Choose which repository this workflow will run against.
      </p>
      <RepoList
        groups={groups}
        selectedId={selectedRepoId}
        onSelect={repo => {
          const r = allRepos.find(x => x.id === repo.id)
          if (r) onSelect(r.id, r.path, r.name)
        }}
        maxHeight="320px"
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 2: Workflow type selection
// ---------------------------------------------------------------------------

function StepKind({
  token,
  repoPath,
  selectedKind,
  onSelect,
}: {
  token: string
  repoPath: string
  selectedKind: string
  onSelect: (kind: string) => void
}) {
  const [kinds, setKinds] = useState<WorkflowKindInfo[]>(
    WORKFLOW_KINDS.map(k => ({ kind: k.value, name: k.label, source: 'builtin' as const }))
  )
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    listKinds(token, repoPath || undefined)
      .then(fetched => {
        if (cancelled) return
        if (fetched.length > 0) setKinds(fetched)
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [token, repoPath])

  // Group by category
  const grouped = new Map<string, WorkflowKindInfo[]>()
  for (const k of kinds) {
    const cat = kindCategory(k.kind)
    if (!grouped.has(cat)) grouped.set(cat, [])
    grouped.get(cat)!.push(k)
  }

  return (
    <div>
      <p className="text-body text-ink-muted mb-3">
        Select the type of automated workflow to run.
      </p>

      {loading && (
        <div className="flex items-center gap-2 py-2 text-body text-ink-muted mb-2">
          <IconLoader2 size={14} stroke={2} className="animate-spin" />
          Checking for repo-specific workflows…
        </div>
      )}

      <div className="space-y-4">
        {Array.from(grouped.entries()).map(([category, items]) => (
          <div key={category}>
            <div className="flex items-center gap-2 mb-2">
              <CategoryBadge kind={items[0].kind} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              {items.map(k => (
                <button
                  key={k.kind}
                  type="button"
                  onClick={() => { onSelect(k.kind); }}
                  className={`rounded-control border px-3 py-2.5 text-left transition-colors ${
                    selectedKind === k.kind
                      ? 'border-accent-6 bg-accent-9/30 ring-1 ring-accent-6/30'
                      : 'border-edge bg-surface hover:border-ink-faint'
                  }`}
                >
                  <span className={`block text-body font-medium ${
                    selectedKind === k.kind ? 'text-accent-2' : 'text-ink'
                  }`}>
                    {k.name}
                  </span>
                  {k.source === 'repo' && (
                    <span className="block text-micro text-ink-muted mt-0.5">repo-specific</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {!loading && (
        <p className="mt-4 text-meta text-ink-muted leading-relaxed">
          You can define custom workflow types by adding <code className="text-ink-muted">.md</code> files
          to <code className="text-ink-muted">{repoPath}/.codekin/workflows/</code>. See the guide on the Workflows page for details.
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 3: Schedule + custom prompt
// ---------------------------------------------------------------------------

function FrequencyButton({
  label, dow, selected, onSelect,
}: {
  label: string; dow: string; selected: boolean; onSelect: (dow: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => { onSelect(dow); }}
      className={`rounded-control border px-3 py-1.5 text-body font-medium transition-colors ${
        selected
          ? 'border-accent-6 bg-accent-9/40 text-accent-2'
          : 'border-edge-strong bg-surface-raised text-ink hover:border-ink-faint hover:text-ink'
      }`}
    >
      {label}
    </button>
  )
}

function StepConfigure({
  token,
  form,
  onChange,
}: {
  token: string
  form: FormState
  onChange: (patch: Partial<FormState>) => void
}) {
  const eventDriven = isEventDriven(form.kind)

  return (
    <div className="space-y-5">
      {/* Schedule section — hidden for event-driven workflows */}
      {eventDriven ? (
        <div>
          <p className="text-body text-ink-muted mb-3">
            {form.kind === 'pr-review'
              ? 'This workflow runs automatically when a pull request is opened or updated via GitHub webhooks.'
              : 'This workflow runs automatically on every commit via a post-commit hook.'}
          </p>
          <div className="rounded-control border border-secondary-7/40 bg-secondary-9/20 px-4 py-3">
            <span className="text-body font-medium text-secondary-4">
              {form.kind === 'pr-review' ? 'Trigger: On pull request' : 'Trigger: On commit'}
            </span>
            <p className="text-body text-ink-muted mt-1">
              {form.kind === 'pr-review'
                ? 'Each PR will be reviewed automatically when opened, updated, or reopened. No schedule needed.'
                : 'Each commit will be reviewed automatically. No schedule needed.'}
            </p>
          </div>
        </div>
      ) : (
        <>
          <div>
            <p className="text-body text-ink-muted mb-3">
              Choose when this workflow should run automatically.
            </p>

            {/* Time picker */}
            <label className="block text-body font-medium text-ink mb-2">Time</label>
            <TimePicker
              hour={form.cronHour}
              minute={form.cronMinute}
              onChange={(h, m) => { onChange({ cronHour: h, cronMinute: m }); }}
            />
          </div>

          <div>
            <label className="block text-body font-medium text-ink mb-2">Frequency</label>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {DAY_PRESETS.map(p => {
                const selected = form.cronDow === p.dow
                return (
                  <FrequencyButton
                    key={p.dow}
                    label={p.label}
                    dow={p.dow}
                    selected={selected}
                    onSelect={dow => { onChange({ cronDow: dow }); }}
                  />
                )
              })}
            </div>
            <div className="flex gap-1.5">
              {DAY_INDIVIDUAL.map(p => {
                const baseDow = isBiweeklyDow(form.cronDow)
                  ? form.cronDow.split('-').slice(1).join('-')
                  : form.cronDow
                const selected = baseDow === p.dow
                return (
                  <FrequencyButton
                    key={p.dow}
                    label={p.label}
                    dow={p.dow}
                    selected={selected}
                    onSelect={dow => {
                      const biweekly = isBiweeklyDow(form.cronDow)
                      onChange({ cronDow: biweekly ? `biweekly-${dow}` : dow })
                    }}
                  />
                )
              })}
            </div>
            {/* Weekly / Bi-weekly toggle — visible when a single day is selected */}
            {(() => {
              const isDay = DAY_INDIVIDUAL.some(d => d.dow === form.cronDow || form.cronDow === `biweekly-${d.dow}`)
              if (!isDay) return null
              const biweekly = isBiweeklyDow(form.cronDow)
              const baseDow = biweekly ? form.cronDow.split('-').slice(1).join('-') : form.cronDow
              return (
                <div className="flex gap-1.5 mt-2">
                  <FrequencyButton
                    label="Every week"
                    dow={baseDow}
                    selected={!biweekly}
                    onSelect={dow => { onChange({ cronDow: dow }); }}
                  />
                  <FrequencyButton
                    label="Every 2 weeks"
                    dow={`biweekly-${baseDow}`}
                    selected={biweekly}
                    onSelect={dow => { onChange({ cronDow: dow }); }}
                  />
                </div>
              )
            })()}
            <div className="mt-2 text-meta text-ink-muted">
              {describeCron(buildCron(form.cronHour, form.cronDow, form.cronMinute))}
            </div>
          </div>
        </>
      )}

      {/* Provider + Model selection */}
      <ProviderModelSection
        token={token}
        workingDir={form.repoPath || undefined}
        provider={form.provider}
        model={form.model}
        onProviderChange={provider => { onChange({ provider }); }}
        onModelChange={model => { onChange({ model }); }}
      />

      <div>
        <label className="block text-body font-medium text-ink mb-1.5">
          Focus areas <span className="text-ink-muted font-normal">(optional)</span>
        </label>
        <textarea
          value={form.customPrompt}
          onChange={e => { onChange({ customPrompt: e.target.value }); }}
          rows={3}
          placeholder="e.g. Focus on the auth module and payment flows"
          className="w-full rounded-control border border-edge-strong bg-surface px-3 py-2 text-body text-ink placeholder-ink-muted focus:border-focus focus:outline-none resize-none"
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// AddWorkflowModal (wizard)
// ---------------------------------------------------------------------------

/** Three-step wizard modal for creating a new workflow: select repo, choose type, configure schedule/options. */
export function AddWorkflowModal({ token, onClose, onAdd }: Props) {
  const [step, setStep] = useState<Step>(1)
  const [selectedRepoId, setSelectedRepoId] = useState('')
  const [form, setForm] = useState({
    kind: '',
    repoPath: '',
    repoName: '',
    cronHour: 6,
    cronMinute: 0,
    cronDow: '*',
    customPrompt: '',
    model: '',
    provider: 'claude' as CodingProvider,
  })
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [webhookResult, setWebhookResult] = useState<WebhookSetupResult | null>(null)

  const eventDriven = isEventDriven(form.kind)
  const updateForm = (patch: Partial<FormState>) => { setForm(f => ({ ...f, ...patch })); }

  const canNext = (): boolean => {
    if (step === 1) return !!form.repoPath
    if (step === 2) return !!form.kind
    return true
  }

  const handleNext = () => {
    setFormError(null)
    if (step === 1 && !form.repoPath) {
      setFormError('Please select a repository')
      return
    }
    if (step === 2 && !form.kind) {
      setFormError('Please select a workflow')
      return
    }
    if (step < 3) setStep((step + 1) as Step)
  }

  const handleBack = () => {
    setFormError(null)
    if (step > 1) setStep((step - 1) as Step)
  }

  const handleSubmit = async () => {
    setSaving(true)
    setFormError(null)
    try {
      const name = form.repoName || form.repoPath.split('/').pop() || 'workflow'
      const cronExpression = eventDriven
        ? EVENT_CRON
        : buildCron(form.cronHour, form.cronDow, form.cronMinute)
      const isPrReview = form.kind === 'pr-review'
      const webhookUrl = isPrReview
        ? `${location.protocol}//${location.host}/cc/api/webhooks/github`
        : undefined
      const setupResult = await onAdd({
        id: `${slugify(name)}-${slugify(form.kind)}`,
        name,
        repoPath: form.repoPath.trim(),
        cronExpression,
        kind: form.kind,
        enabled: true,
        customPrompt: form.customPrompt.trim() || undefined,
        model: form.model || undefined,
        provider: form.provider !== 'claude' ? form.provider : undefined,
      }, webhookUrl)
      if (isPrReview) {
        setWebhookResult(setupResult ?? {
          status: 'failed',
          message: 'No webhook setup information returned. Please configure the GitHub webhook manually in Settings.',
        })
      } else {
        onClose()
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to add workflow')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-[520px] max-h-[90vh] overflow-y-auto rounded-floating border border-edge-strong bg-surface-raised p-6 shadow-floating"
        onClick={e => { e.stopPropagation(); }}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-head font-semibold text-ink">New Workflow</h2>
          <button onClick={onClose} className="rounded-control p-1 text-ink-muted hover:text-ink hover:bg-edge">
            <IconX size={16} stroke={2} />
          </button>
        </div>

        {webhookResult ? (
          /* Webhook setup result screen */
          <>
            <div className="min-h-[120px] py-2">
              {webhookResult.status === 'failed' ? (
                <div className="space-y-3">
                  <div className="flex items-start gap-3 rounded-control border border-warning-7/40 bg-warning-9/20 px-4 py-3">
                    <IconAlertTriangle size={18} stroke={2} className="text-warning-4 mt-0.5 shrink-0" />
                    <div>
                      <p className="text-body font-medium text-warning-3">Webhook setup required</p>
                      <p className="text-body text-ink-muted mt-1">{webhookResult.message}</p>
                    </div>
                  </div>
                  <div className="rounded-control border border-edge bg-surface px-4 py-3">
                    <p className="text-body font-medium text-ink mb-2">To enable PR reviews, configure the webhook:</p>
                    <ol className="text-body text-ink-muted space-y-1.5 list-decimal list-inside">
                      <li>Go to <span className="text-ink font-medium">Settings</span> (gear icon in the sidebar)</li>
                      <li>Scroll to <span className="text-ink font-medium">GitHub Webhooks</span></li>
                      <li>Enter the repository name and click <span className="text-ink font-medium">Setup</span></li>
                    </ol>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-3 rounded-control border border-success-7/40 bg-success-9/20 px-4 py-3">
                  <IconCheck size={18} stroke={2} className="text-success-4 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-body font-medium text-success-3">Workflow created</p>
                    <p className="text-body text-ink-muted mt-1">
                      {webhookResult.message} PRs will be reviewed automatically when opened or updated.
                    </p>
                  </div>
                </div>
              )}
            </div>

            <div className="flex justify-end mt-5 pt-4 border-t border-edge">
              <button
                type="button"
                onClick={onClose}
                className="rounded-control bg-primary-8 px-4 py-2 text-body font-medium text-on-primary hover:bg-primary-7 transition-colors"
              >
                Done
              </button>
            </div>
          </>
        ) : (
          /* Wizard steps */
          <>
            {/* Step indicator */}
            <StepIndicator current={step} eventDriven={eventDriven} />

            {/* Step content */}
            <div className="min-h-[200px]">
              {step === 1 && (
                <StepRepo
                  token={token}
                  selectedRepoId={selectedRepoId}
                  onSelect={(id, path, name) => {
                    setSelectedRepoId(id)
                    updateForm({ repoPath: path, repoName: name })
                  }}
                />
              )}

              {step === 2 && (
                <StepKind
                  token={token}
                  repoPath={form.repoPath}
                  selectedKind={form.kind}
                  onSelect={kind => { updateForm({ kind }); }}
                />
              )}

              {step === 3 && (
                <StepConfigure
                  token={token}
                  form={form}
                  onChange={updateForm}
                />
              )}
            </div>

            {/* Error */}
            {formError && (
              <div className="rounded-control bg-error-10/50 px-3 py-2 text-body text-error-4 mt-3">{formError}</div>
            )}

            {/* Navigation */}
            <div className="flex gap-2 mt-5 pt-4 border-t border-edge">
              {step > 1 ? (
                <button
                  type="button"
                  onClick={handleBack}
                  className="flex items-center gap-1.5 rounded-control border border-edge-strong bg-surface-raised px-4 py-2 text-body text-ink hover:bg-edge hover:text-ink transition-colors"
                >
                  <IconArrowLeft size={14} stroke={2} />
                  Back
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-control border border-edge-strong bg-surface-raised px-4 py-2 text-body text-ink hover:bg-edge hover:text-ink transition-colors"
                >
                  Cancel
                </button>
              )}

              <div className="flex-1" />

              {step < 3 ? (
                <button
                  type="button"
                  onClick={handleNext}
                  disabled={!canNext()}
                  className="flex items-center gap-1.5 rounded-control bg-primary-8 px-4 py-2 text-body font-medium text-on-primary hover:bg-primary-7 disabled:opacity-40 transition-colors"
                >
                  Next
                  <IconArrowRight size={14} stroke={2} />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={saving}
                  className="flex items-center gap-1.5 rounded-control bg-primary-8 px-4 py-2 text-body font-medium text-on-primary hover:bg-primary-7 disabled:opacity-50 transition-colors"
                >
                  {saving ? (
                    <>
                      <IconLoader2 size={14} stroke={2} className="animate-spin" />
                      {form.kind === 'pr-review' ? 'Setting up…' : 'Creating…'}
                    </>
                  ) : (
                    <>
                      <IconCheck size={14} stroke={2} />
                      Create Workflow
                    </>
                  )}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
