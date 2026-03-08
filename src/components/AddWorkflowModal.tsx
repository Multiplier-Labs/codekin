/**
 * Modal dialog for registering a new scheduled workflow.
 */

import { useState, useEffect } from 'react'
import { IconX, IconLoader2 } from '@tabler/icons-react'
import { useRepos } from '../hooks/useRepos'
import { listKinds } from '../lib/workflowApi'
import type { ReviewRepoConfig, WorkflowKindInfo } from '../lib/workflowApi'
import {
  WORKFLOW_KINDS, DAY_PATTERNS,
  buildCron, formatHour, describeCron, slugify,
} from '../lib/workflowHelpers'
import { CategoryBadge } from './WorkflowBadges'
import { RepoList } from './RepoList'

interface FormState {
  kind: string
  repoPath: string
  repoName: string
  cronHour: number
  cronDow: string
  customPrompt: string
}

interface Props {
  token: string
  onClose: () => void
  onAdd: (repo: ReviewRepoConfig) => Promise<void>
}

export function AddWorkflowModal({ token, onClose, onAdd }: Props) {
  const { groups, loading: reposLoading, error: reposError } = useRepos(token)
  const allRepos = groups.flatMap(g => g.repos)

  const [selectedRepoId, setSelectedRepoId] = useState<string>('')
  const [form, setForm] = useState<FormState>({
    kind: '',
    repoPath: '',
    repoName: '',
    cronHour: 6,
    cronDow: '*',
    customPrompt: '',
  })
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  // Dynamic kinds: built-in fallback + fetched from server (repo-aware)
  const [kinds, setKinds] = useState<WorkflowKindInfo[]>(
    WORKFLOW_KINDS.map(k => ({ kind: k.value, name: k.label, source: 'builtin' as const }))
  )
  const [kindsLoading, setKindsLoading] = useState(false)

  // Fetch kinds when repo selection changes (includes repo-specific workflows)
  useEffect(() => {
    let cancelled = false
    setKindsLoading(true)
    listKinds(token, form.repoPath || undefined)
      .then(fetched => {
        if (cancelled) return
        if (fetched.length > 0) {
          setKinds(fetched)
          // Auto-select first kind if current selection is not in the new list
          if (!fetched.some(k => k.kind === form.kind)) {
            setForm(f => ({ ...f, kind: fetched[0].kind }))
          }
        }
      })
      .catch(() => { /* keep fallback */ })
      .finally(() => { if (!cancelled) setKindsLoading(false) })
    return () => { cancelled = true }
  }, [token, form.repoPath])

  const handleRepoSelect = (repoId: string) => {
    setSelectedRepoId(repoId)
    const repo = allRepos.find(r => r.id === repoId)
    if (repo) {
      setForm(f => ({ ...f, repoPath: repo.path, repoName: repo.name }))
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.repoPath.trim()) { setFormError('Please select a repository'); return }
    if (!form.kind) { setFormError('Please select a workflow'); return }

    setSaving(true)
    setFormError(null)
    try {
      const name = form.repoName || form.repoPath.split('/').pop() || 'workflow'
      await onAdd({
        id: `${slugify(name)}-${slugify(form.kind)}`,
        name,
        repoPath: form.repoPath.trim(),
        cronExpression: buildCron(form.cronHour, form.cronDow),
        kind: form.kind,
        enabled: true,
        customPrompt: form.customPrompt.trim() || undefined,
      })
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to add workflow')
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
          <h2 className="text-[17px] font-semibold text-neutral-1">Add Workflow</h2>
          <button onClick={onClose} className="rounded p-1 text-neutral-4 hover:text-neutral-1 hover:bg-neutral-9">
            <IconX size={16} stroke={2} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Repo selector */}
          <div>
            <label className="block text-[13px] font-medium text-neutral-3 mb-1.5">Repository</label>
            {reposLoading ? (
              <div className="flex items-center gap-2 py-2 text-[13px] text-neutral-5">
                <IconLoader2 size={14} stroke={2} className="animate-spin" />
                Loading repos…
              </div>
            ) : reposError ? (
              <div className="rounded-md bg-error-10/50 px-3 py-2 text-[13px] text-error-4">
                Failed to load repos: {reposError}
              </div>
            ) : (
              <RepoList
                groups={groups}
                selectedId={selectedRepoId}
                onSelect={repo => handleRepoSelect(repo.id)}
                maxHeight="180px"
              />
            )}
          </div>

          {/* Workflow kind */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-[13px] font-medium text-neutral-3">Workflow</label>
              <div className="flex items-center gap-2">
                {kindsLoading && <IconLoader2 size={12} stroke={2} className="animate-spin text-neutral-5" />}
                {form.kind && <CategoryBadge kind={form.kind} />}
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {kinds.map(k => (
                <button
                  key={k.kind}
                  type="button"
                  onClick={() => setForm(f => ({ ...f, kind: k.kind }))}
                  className={`rounded-md border py-2 text-[13px] font-medium transition-colors
                    ${form.kind === k.kind
                      ? 'border-accent-6 bg-accent-9/40 text-accent-2'
                      : 'border-neutral-7 bg-neutral-10 text-neutral-3 hover:border-neutral-6 hover:text-neutral-2'
                    }`}
                >
                  {k.name}
                  {k.source === 'repo' && (
                    <span className="block text-[10px] text-neutral-5 font-normal mt-0.5">repo</span>
                  )}
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

          {/* Custom prompt (optional) */}
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
              {saving ? 'Adding…' : 'Add Workflow'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
