/**
 * Modal dialog for editing an existing scheduled workflow.
 */

import { useState } from 'react'
import { IconX, IconClock } from '@tabler/icons-react'
import type { CronSchedule, ReviewRepoConfig, WorkflowRun } from '../lib/workflowApi'
import {
  WORKFLOW_KINDS, DAY_PATTERNS,
  buildCron, parseCron, formatHour, describeCron, formatTime, formatDuration, kindLabel,
} from '../lib/workflowHelpers'
import { CategoryBadge, StatusBadge } from './WorkflowBadges'

interface Props {
  repo: ReviewRepoConfig
  schedules: CronSchedule[]
  recentRuns: WorkflowRun[]
  onClose: () => void
  onSave: (id: string, patch: Partial<ReviewRepoConfig>) => Promise<void>
}

export function EditWorkflowModal({ repo, schedules, recentRuns, onClose, onSave }: Props) {
  const parsed = parseCron(repo.cronExpression)
  const [form, setForm] = useState({
    kind: repo.kind ?? 'coverage.daily',
    cronHour: parsed.hour,
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
        cronExpression: buildCron(form.cronHour, form.cronDow),
        customPrompt: form.customPrompt.trim() || undefined,
      })
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save workflow')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-[480px] max-h-[90vh] overflow-y-auto rounded-xl border border-neutral-7 bg-neutral-11 p-6 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-[17px] font-semibold text-neutral-1">Edit Workflow</h2>
            <p className="text-[13px] text-neutral-4 mt-0.5">{repo.repoPath.split('/').pop() || repo.name}</p>
          </div>
          <button onClick={onClose} className="rounded p-1 text-neutral-4 hover:text-neutral-1 hover:bg-neutral-9">
            <IconX size={16} stroke={2} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Workflow kind */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-[13px] font-medium text-neutral-3">Workflow</label>
              <CategoryBadge kind={form.kind} />
            </div>
            <div className="grid grid-cols-3 gap-2">
              {WORKFLOW_KINDS.map(k => (
                <button
                  key={k.value}
                  type="button"
                  onClick={() => setForm(f => ({ ...f, kind: k.value }))}
                  className={`rounded-md border py-2 text-[13px] font-medium transition-colors
                    ${form.kind === k.value
                      ? 'border-accent-6 bg-accent-9/40 text-accent-2'
                      : 'border-neutral-7 bg-neutral-10 text-neutral-3 hover:border-neutral-6 hover:text-neutral-2'
                    }`}
                >
                  {k.label}
                </button>
              ))}
            </div>
          </div>

          {/* Schedule */}
          <div>
            <label className="block text-[13px] font-medium text-neutral-3 mb-1.5">Schedule</label>
            <div className="flex gap-2 mb-2">
              <select
                value={form.cronHour}
                onChange={e => setForm(f => ({ ...f, cronHour: parseInt(e.target.value) }))}
                className="rounded-md border border-neutral-7 bg-neutral-10 px-3 py-2 text-[15px] text-neutral-1 focus:border-accent-6 focus:outline-none"
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>{formatHour(h)}</option>
                ))}
              </select>
              <div className="flex flex-wrap gap-1.5 flex-1">
                {DAY_PATTERNS.map(p => (
                  <button
                    key={p.dow}
                    type="button"
                    onClick={() => setForm(f => ({ ...f, cronDow: p.dow }))}
                    className={`rounded-md border px-2.5 py-1.5 text-[13px] transition-colors
                      ${form.cronDow === p.dow
                        ? 'border-accent-6 bg-accent-9/40 text-accent-2'
                        : 'border-neutral-7 bg-neutral-10 text-neutral-3 hover:border-neutral-6 hover:text-neutral-2'
                      }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="text-[13px] text-neutral-5">
              {describeCron(buildCron(form.cronHour, form.cronDow))}
            </div>
          </div>

          {/* Custom prompt */}
          <div>
            <label className="block text-[13px] font-medium text-neutral-3 mb-1.5">
              Additional focus areas <span className="text-neutral-5 font-normal">(optional)</span>
            </label>
            <textarea
              value={form.customPrompt}
              onChange={e => setForm(f => ({ ...f, customPrompt: e.target.value }))}
              rows={3}
              placeholder="e.g. Focus on the auth module and payment flows"
              className="w-full rounded-md border border-neutral-7 bg-neutral-10 px-3 py-2 text-[15px] text-neutral-1 placeholder-neutral-5 focus:border-accent-6 focus:outline-none resize-none"
            />
          </div>

          {/* Scheduled entries (read-only info) */}
          {schedules.length > 0 && (
            <div>
              <label className="block text-[13px] font-medium text-neutral-3 mb-1.5">Scheduled entries</label>
              <div className="space-y-1">
                {schedules.map(s => (
                  <div key={s.id} className="flex items-center justify-between rounded-md border border-neutral-8/50 bg-neutral-10/60 px-2.5 py-1.5">
                    <span className="text-[13px] text-neutral-3 font-mono">{describeCron(s.cronExpression)}</span>
                    {!s.enabled && (
                      <span className="text-[12px] text-warning-5 bg-warning-10/40 border border-warning-8/40 rounded-full px-2 py-0.5">paused</span>
                    )}
                    {s.nextRunAt && s.enabled && (
                      <span className="text-[13px] text-neutral-5 flex items-center gap-1">
                        <IconClock size={12} stroke={2} />
                        {formatTime(s.nextRunAt)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Recent runs (read-only info) */}
          {recentRuns.length > 0 && (
            <div>
              <label className="block text-[13px] font-medium text-neutral-3 mb-1.5">Recent runs</label>
              <div className="space-y-1">
                {recentRuns.slice(0, 5).map(run => (
                  <div key={run.id} className="flex items-center gap-2 rounded-md border border-neutral-8/50 bg-neutral-10/60 px-2.5 py-1.5">
                    <span className="text-[13px] text-neutral-4 font-mono tabular-nums">{formatTime(run.createdAt)}</span>
                    <span className="text-[13px] text-neutral-5">{kindLabel(run.kind)}</span>
                    <span className="ml-auto"><StatusBadge status={run.status} /></span>
                    <span className="text-[13px] text-neutral-5 tabular-nums">{formatDuration(run.startedAt, run.completedAt)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {formError && (
            <div className="rounded-md bg-error-10/50 px-3 py-2 text-[13px] text-error-4">{formError}</div>
          )}

          <div className="flex gap-2 pt-1">
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
              className="flex-1 rounded-md bg-accent-7 py-2 text-[15px] font-medium text-white hover:bg-accent-6 disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
