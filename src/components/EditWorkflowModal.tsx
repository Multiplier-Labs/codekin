/**
 * Modal dialog for editing an existing scheduled workflow.
 * Focused on editable fields only — schedule, workflow kind, and custom prompt.
 */

import { useState } from 'react'
import { IconX, IconLoader2 } from '@tabler/icons-react'
import type { ReviewRepoConfig } from '../lib/workflowApi'
import {
  WORKFLOW_KINDS, DAY_PRESETS, DAY_INDIVIDUAL,
  buildCron, parseCron, describeCron, kindLabel,
  toTimeValue, fromTimeValue,
} from '../lib/workflowHelpers'
import { CategoryBadge } from './WorkflowBadges'

interface Props {
  repo: ReviewRepoConfig
  schedules?: unknown[]
  recentRuns?: unknown[]
  onClose: () => void
  onSave: (id: string, patch: Partial<ReviewRepoConfig>) => Promise<void>
}

export function EditWorkflowModal({ repo, onClose, onSave }: Props) {
  const parsed = parseCron(repo.cronExpression)
  const [form, setForm] = useState({
    kind: repo.kind ?? 'coverage.daily',
    cronHour: parsed.hour,
    cronMinute: parsed.minute,
    cronDow: parsed.dow,
    customPrompt: repo.customPrompt ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setFormError(null)
    try {
      await onSave(repo.id, {
        kind: form.kind,
        cronExpression: buildCron(form.cronHour, form.cronDow, form.cronMinute),
        customPrompt: form.customPrompt.trim() || undefined,
      })
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save workflow')
    } finally {
      setSaving(false)
    }
  }

  const repoShortName = repo.repoPath.split('/').pop() || repo.name

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

          {/* Schedule */}
          <div>
            <label className="block text-[13px] font-medium text-neutral-3 mb-2">Time</label>
            <input
              type="time"
              step={900}
              value={toTimeValue(form.cronHour, form.cronMinute)}
              onChange={e => {
                const { hour, minute } = fromTimeValue(e.target.value)
                setForm(f => ({ ...f, cronHour: hour, cronMinute: minute }))
              }}
              className="rounded-md border border-neutral-7 bg-neutral-10 px-3 py-2 text-[15px] text-neutral-1 focus:border-accent-6 focus:outline-none w-full mb-3"
            />
            <label className="block text-[13px] font-medium text-neutral-3 mb-2">Frequency</label>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {DAY_PRESETS.map(p => (
                <button
                  key={p.dow}
                  type="button"
                  onClick={() => setForm(f => ({ ...f, cronDow: p.dow }))}
                  className={`rounded-md border px-3 py-1.5 text-[13px] font-medium transition-colors ${
                    form.cronDow === p.dow
                      ? 'border-accent-6 bg-accent-9/40 text-accent-2'
                      : 'border-neutral-7 bg-neutral-10 text-neutral-3 hover:border-neutral-6 hover:text-neutral-2'
                  }`}
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
                  onClick={() => setForm(f => ({ ...f, cronDow: p.dow }))}
                  className={`rounded-md border px-3 py-1.5 text-[13px] font-medium transition-colors ${
                    form.cronDow === p.dow
                      ? 'border-accent-6 bg-accent-9/40 text-accent-2'
                      : 'border-neutral-7 bg-neutral-10 text-neutral-3 hover:border-neutral-6 hover:text-neutral-2'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="mt-2 text-[13px] text-neutral-5">
              {describeCron(buildCron(form.cronHour, form.cronDow, form.cronMinute))}
            </div>
          </div>

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
