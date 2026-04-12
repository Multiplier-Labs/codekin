/**
 * Modal dialog for editing an existing workflow.
 * Adapts for event-driven workflows by hiding the schedule section.
 */

import { useState } from 'react'
import { IconX, IconLoader2 } from '@tabler/icons-react'
import type { ReviewRepoConfig } from '../lib/workflowApi'
import {
  WORKFLOW_KINDS, DAY_PRESETS, DAY_INDIVIDUAL, isBiweeklyDow,
  buildCron, parseCron, describeCron, kindLabel, isEventDriven, EVENT_CRON,
} from '../lib/workflowHelpers'
import type { CodingProvider } from '../types'
import { CategoryBadge } from './WorkflowBadges'
import TimePicker from './TimePicker'
import { ProviderModelSection } from './workflows/ProviderModelSection'

const btnClass = (selected: boolean) =>
  `rounded-md border px-3 py-1.5 text-[13px] font-medium transition-colors ${
    selected
      ? 'border-accent-6 bg-accent-9/40 text-accent-2'
      : 'border-neutral-7 bg-neutral-10 text-neutral-3 hover:border-neutral-6 hover:text-neutral-2'
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
  const [form, setForm] = useState({
    kind: repo.kind ?? 'coverage.daily',
    cronHour: parsed.hour,
    cronMinute: parsed.minute,
    cronDow: parsed.dow,
    customPrompt: repo.customPrompt ?? '',
    model: repo.model ?? '',
    provider: (repo.provider ?? 'claude') as CodingProvider,
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
        className="w-[480px] max-h-[90vh] overflow-y-auto rounded-xl border border-neutral-7 bg-neutral-11 p-6 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-[19px] font-semibold text-neutral-1">Edit Workflow</h2>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-[13px] text-neutral-4">{repoShortName}</span>
              <span className="text-neutral-7">·</span>
              <span className="text-[13px] text-neutral-4">{kindLabel(repo.kind ?? '')}</span>
            </div>
          </div>
          <button onClick={onClose} className="rounded p-1 text-neutral-4 hover:text-neutral-1 hover:bg-neutral-9">
            <IconX size={16} stroke={2} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Workflow kind */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-[13px] font-medium text-neutral-3">Workflow type</label>
              <CategoryBadge kind={form.kind} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              {WORKFLOW_KINDS.map(k => (
                <button
                  key={k.value}
                  type="button"
                  onClick={() => setForm(f => ({ ...f, kind: k.value }))}
                  className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    form.kind === k.value
                      ? 'border-accent-6 bg-accent-9/30 ring-1 ring-accent-6/30'
                      : 'border-neutral-7 bg-neutral-10 hover:border-neutral-6'
                  }`}
                >
                  <span className={`block text-[15px] font-medium ${
                    form.kind === k.value ? 'text-accent-2' : 'text-neutral-2'
                  }`}>
                    {k.label}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Schedule — hidden for event-driven workflows */}
          {eventDriven ? (
            <div className="rounded-lg border border-purple-700/40 bg-purple-900/20 px-4 py-3">
              <span className="text-[14px] font-medium text-purple-400">
                {form.kind === 'pr-review' ? 'Trigger: On pull request' : 'Trigger: On commit'}
              </span>
              <p className="text-[13px] text-neutral-4 mt-1">
                {form.kind === 'pr-review'
                  ? 'Each PR will be reviewed automatically when opened, updated, or reopened. No schedule needed.'
                  : 'Each commit will be reviewed automatically. No schedule needed.'}
              </p>
            </div>
          ) : (
            <div>
              <label className="block text-[13px] font-medium text-neutral-3 mb-2">Time</label>
              <TimePicker
                hour={form.cronHour}
                minute={form.cronMinute}
                onChange={(h, m) => setForm(f => ({ ...f, cronHour: h, cronMinute: m }))}
                className="mb-3"
              />
              <label className="block text-[13px] font-medium text-neutral-3 mb-2">Frequency</label>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {DAY_PRESETS.map(p => (
                  <button
                    key={p.dow}
                    type="button"
                    onClick={() => setForm(f => ({ ...f, cronDow: p.dow }))}
                    className={btnClass(form.cronDow === p.dow)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="flex gap-1.5">
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
              {isDay && (
                <div className="flex gap-1.5 mt-2">
                  <button type="button" onClick={() => setForm(f => ({ ...f, cronDow: baseDow }))} className={btnClass(!biweekly)}>
                    Every week
                  </button>
                  <button type="button" onClick={() => setForm(f => ({ ...f, cronDow: `biweekly-${baseDow}` }))} className={btnClass(biweekly)}>
                    Every 2 weeks
                  </button>
                </div>
              )}
              <div className="mt-2 text-[13px] text-neutral-5">
                {describeCron(buildCron(form.cronHour, form.cronDow, form.cronMinute))}
              </div>
            </div>
          )}

          {/* Provider + Model selection */}
          <ProviderModelSection
            token={token}
            workingDir={repo.repoPath}
            provider={form.provider}
            model={form.model}
            onProviderChange={provider => setForm(f => ({ ...f, provider }))}
            onModelChange={model => setForm(f => ({ ...f, model }))}
          />

          {/* Custom prompt */}
          <div>
            <label className="block text-[13px] font-medium text-neutral-3 mb-1.5">
              Focus areas <span className="text-neutral-5 font-normal">(optional)</span>
            </label>
            <textarea
              value={form.customPrompt}
              onChange={e => setForm(f => ({ ...f, customPrompt: e.target.value }))}
              rows={3}
              placeholder="e.g. Focus on the auth module and payment flows"
              className="w-full rounded-md border border-neutral-7 bg-neutral-10 px-3 py-2 text-[15px] text-neutral-1 placeholder-neutral-5 focus:border-accent-6 focus:outline-none resize-none"
            />
          </div>

          {formError && (
            <div className="rounded-md bg-error-10/50 px-3 py-2 text-[13px] text-error-4">{formError}</div>
          )}

          <div className="flex gap-2 pt-2 border-t border-neutral-8/50">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-md border border-neutral-7 bg-neutral-10 py-2 text-[15px] text-neutral-3 hover:bg-neutral-9 hover:text-neutral-1 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 rounded-md bg-primary-8 py-2 text-[15px] font-medium text-neutral-1 hover:bg-primary-7 disabled:opacity-50 transition-colors flex items-center justify-center gap-1.5"
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
