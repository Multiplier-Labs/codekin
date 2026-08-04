/**
 * Modal dialog for editing an existing workflow.
 * Adapts for event-driven workflows by hiding the schedule section.
 */

import { useState } from 'react'
import { IconX, IconLoader2 } from '@tabler/icons-react'
import type { ReviewRepoConfig } from '../lib/workflowApi'
import {
  WORKFLOW_KINDS, DAY_PRESETS, DAY_INDIVIDUAL, isBiweeklyDow,
  buildCron, parseCron, describeCron, kindLabel, isEventDriven, EVENT_CRON, normalizeModel,
} from '../lib/workflowHelpers'
import type { CodingProvider } from '../types'
import { CategoryBadge } from './WorkflowBadges'
import TimePicker from './TimePicker'
import { ProviderModelSection } from './workflows/ProviderModelSection'

const btnClass = (selected: boolean) =>
  `rounded-control border px-3 py-1.5 text-body font-medium transition-colors ${
    selected
      ? 'border-accent-6 bg-accent-9/40 text-accent-2'
      : 'border-edge-strong bg-surface-raised text-ink hover:border-ink-faint hover:text-ink'
  }`

interface Props {
  token: string
  repo: ReviewRepoConfig
  schedules?: unknown[]
  recentRuns?: unknown[]
  onClose: () => void
  onSave: (id: string, patch: Partial<ReviewRepoConfig>) => Promise<void>
}

export function EditWorkflowModal({ token, repo, onClose, onSave }: Props) {
  const parsed = parseCron(repo.cronExpression)
  // Infer provider from model when provider field is missing (legacy configs).
  // OpenCode models are "providerID/modelID" (contain a slash); Claude models
  // never do (full IDs like "claude-sonnet-4-6" or aliases like "opus").
  const inferredProvider: CodingProvider =
    repo.provider ?? (repo.model?.includes('/') ? 'opencode' : 'claude')

  const [form, setForm] = useState({
    kind: repo.kind ?? 'coverage.daily',
    cronHour: parsed.hour,
    cronMinute: parsed.minute,
    cronDow: parsed.dow,
    customPrompt: repo.customPrompt ?? '',
    model: normalizeModel(repo.model),
    provider: inferredProvider,
  })
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const eventDriven = isEventDriven(form.kind)

  const handleSubmit = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault()
    setSaving(true)
    setFormError(null)
    try {
      const cronExpression = eventDriven
        ? EVENT_CRON
        : buildCron(form.cronHour, form.cronDow, form.cronMinute)
      await onSave(repo.id, {
        kind: form.kind,
        cronExpression,
        customPrompt: form.customPrompt.trim() || undefined,
        model: form.model || undefined,
        provider: form.provider !== 'claude' ? form.provider : undefined,
      })
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save workflow')
    } finally {
      setSaving(false)
    }
  }

  const repoShortName = repo.repoPath.split('/').pop() || repo.name
  const biweekly = isBiweeklyDow(form.cronDow)
  const baseDow = biweekly ? form.cronDow.split('-').slice(1).join('-') : form.cronDow
  const isDay = DAY_INDIVIDUAL.some(d => d.dow === baseDow)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-[740px] max-h-[90vh] overflow-y-auto rounded-floating border border-edge-strong bg-surface-raised p-5 shadow-floating"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-head font-semibold text-ink">Edit Workflow</h2>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-meta text-ink-muted">{repoShortName}</span>
              <span className="text-ink-faint">·</span>
              <span className="text-meta text-ink-muted">{kindLabel(repo.kind ?? '')}</span>
            </div>
          </div>
          <button onClick={onClose} className="rounded-control p-1 text-ink-muted hover:text-ink hover:bg-edge">
            <IconX size={16} stroke={2} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3.5">
          {/* Two-column layout: Workflow type | Schedule */}
          <div className="grid grid-cols-2 gap-4">
            {/* Left column — Workflow kind */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-body font-medium text-ink">Workflow type</label>
                <CategoryBadge kind={form.kind} />
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {WORKFLOW_KINDS.map(k => (
                  <button
                    key={k.value}
                    type="button"
                    onClick={() => setForm(f => ({ ...f, kind: k.value }))}
                    className={`rounded-control border px-2.5 py-1.5 text-left transition-colors ${
                      form.kind === k.value
                        ? 'border-accent-6 bg-accent-9/30 ring-1 ring-accent-6/30'
                        : 'border-edge bg-surface hover:border-ink-faint'
                    }`}
                  >
                    <span className={`block text-meta font-medium leading-tight ${
                      form.kind === k.value ? 'text-accent-2' : 'text-ink'
                    }`}>
                      {k.label}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* Right column — Schedule */}
            <div>
              {/* Schedule — hidden for event-driven workflows */}
              {eventDriven ? (
                <div className="rounded-control border border-secondary-7/40 bg-secondary-9/20 px-3 py-2.5">
                  <span className="text-body font-medium text-secondary-4">
                    {form.kind === 'pr-review' ? 'Trigger: On pull request' : 'Trigger: On commit'}
                  </span>
                  <p className="text-meta text-ink-muted mt-0.5">
                    {form.kind === 'pr-review'
                      ? 'Runs automatically when PRs are opened or updated.'
                      : 'Runs automatically on each commit.'}
                  </p>
                </div>
              ) : (
                <div>
                  <div className="flex items-center gap-3 mb-2.5">
                    <div>
                      <label className="block text-body font-medium text-ink mb-1">Time</label>
                      <TimePicker
                        hour={form.cronHour}
                        minute={form.cronMinute}
                        onChange={(h, m) => setForm(f => ({ ...f, cronHour: h, cronMinute: m }))}
                      />
                    </div>
                    {isDay && (
                      <div>
                        <label className="block text-body font-medium text-ink mb-1">Repeat</label>
                        <div className="flex gap-1">
                          <button type="button" onClick={() => setForm(f => ({ ...f, cronDow: baseDow }))} className={btnClass(!biweekly)}>
                            Weekly
                          </button>
                          <button type="button" onClick={() => setForm(f => ({ ...f, cronDow: `biweekly-${baseDow}` }))} className={btnClass(biweekly)}>
                            Biweekly
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                  <label className="block text-body font-medium text-ink mb-1">Frequency</label>
                  <div className="flex flex-wrap gap-1 mb-1.5">
                    {DAY_PRESETS.map(p => {
                      const isActive = form.cronDow === p.dow
                        || (p.dow === '1-5' && isDay && Number(baseDow) >= 1 && Number(baseDow) <= 5)
                      return (
                        <button
                          key={p.dow}
                          type="button"
                          onClick={() => setForm(f => ({ ...f, cronDow: p.dow }))}
                          className={btnClass(isActive)}
                        >
                          {p.label}
                        </button>
                      )
                    })}
                  </div>
                  <div className="flex gap-1">
                    {DAY_INDIVIDUAL.map(p => (
                      <button
                        key={p.dow}
                        type="button"
                        onClick={() => setForm(f => ({ ...f, cronDow: biweekly ? `biweekly-${p.dow}` : p.dow }))}
                        className={btnClass(baseDow === p.dow)}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                  <div className="mt-1 text-meta text-ink-muted">
                    {describeCron(buildCron(form.cronHour, form.cronDow, form.cronMinute))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Provider + Model — full width, compact row */}
          <ProviderModelSection
            token={token}
            workingDir={repo.repoPath}
            provider={form.provider}
            model={form.model}
            onProviderChange={provider => setForm(f => ({ ...f, provider }))}
            onModelChange={model => setForm(f => ({ ...f, model }))}
          />

          {/* Custom prompt — full width */}
          <div>
            <label className="block text-body font-medium text-ink mb-1">
              Focus areas <span className="text-ink-muted font-normal">(optional)</span>
            </label>
            <textarea
              value={form.customPrompt}
              onChange={e => setForm(f => ({ ...f, customPrompt: e.target.value }))}
              rows={2}
              placeholder="e.g. Focus on the auth module and payment flows"
              className="w-full rounded-control border border-edge-strong bg-surface px-3 py-2 text-body text-ink placeholder-ink-muted focus:border-focus focus:outline-none resize-none"
            />
          </div>

          {formError && (
            <div className="rounded-control bg-error-10/50 px-3 py-2 text-body text-error-4">{formError}</div>
          )}

          <div className="flex gap-2 pt-2 border-t border-edge">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-control border border-edge-strong bg-surface-raised py-2 text-body text-ink hover:bg-edge hover:text-ink transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 rounded-control bg-primary-8 py-2 text-body font-medium text-on-primary hover:bg-primary-7 disabled:opacity-50 transition-colors flex items-center justify-center gap-1.5"
            >
              {saving ? (
                <>
                  <IconLoader2 size={14} stroke={2} className="animate-spin" />
                  Saving…
                </>
              ) : (
                'Save Changes'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
