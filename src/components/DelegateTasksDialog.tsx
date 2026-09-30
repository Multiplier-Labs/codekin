/**
 * "Delegate tasks" — hand one or more tasks in a repo to Joe.
 *
 * One task per line (list markers are stripped), optional shared acceptance
 * criteria, and how finished work should land. Submitting creates the tasks
 * and notifies Joe, who starts each one under the repo's policy.
 */

import { useState } from 'react'
import { IconX, IconLoader2 } from '@tabler/icons-react'
import { delegateTasks, parseTaskLines, repoName, type TaskCompletionPolicy } from '../lib/tasksApi'

interface Props {
  token: string
  /** Absolute repo paths to choose from. */
  repos: string[]
  initialRepo?: string
  agentName: string
  onClose: () => void
  onDelegated: () => void
}

const POLICIES: { id: TaskCompletionPolicy; label: string; hint: string }[] = [
  { id: 'pr', label: 'Pull request', hint: 'Opens a PR for you to review (recommended)' },
  { id: 'merge', label: 'Push the branch', hint: 'Pushes the branch without opening a PR' },
  { id: 'commit-only', label: 'Commit only', hint: 'Commits locally in the task’s worktree' },
]

export function DelegateTasksDialog({ token, repos, initialRepo, agentName, onClose, onDelegated }: Props) {
  const [repo, setRepo] = useState(initialRepo || repos[0] || '')
  const [text, setText] = useState('')
  const [acceptance, setAcceptance] = useState('')
  const [policy, setPolicy] = useState<TaskCompletionPolicy>('pr')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const tasks = parseTaskLines(text)
  const tooMany = tasks.length > 20

  async function submit() {
    if (!repo || tasks.length === 0 || tooMany) return
    setSubmitting(true)
    setError(null)
    try {
      await delegateTasks(token, { repo, tasks, acceptance: acceptance.trim() || undefined, completionPolicy: policy })
      onDelegated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delegate tasks')
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delegate-tasks-title"
        className="w-full max-w-[560px] max-h-[90vh] overflow-y-auto rounded-floating border border-edge-strong bg-surface-raised p-5 shadow-floating"
        onClick={e => { e.stopPropagation() }}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="delegate-tasks-title" className="text-title font-semibold text-ink">Delegate tasks to {agentName}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-ink-muted hover:text-ink">
            <IconX size={18} stroke={2} />
          </button>
        </div>

        <form onSubmit={e => { e.preventDefault(); void submit() }} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1">
            <span className="text-meta font-medium text-ink">Repository</span>
            <select
              value={repo}
              onChange={e => { setRepo(e.target.value) }}
              className="rounded-control border border-edge bg-page px-2 py-1.5 text-body text-ink focus:border-focus focus:outline-none"
            >
              {repos.length === 0 && <option value="">No repositories found</option>}
              {repos.map(path => <option key={path} value={path}>{repoName(path)}</option>)}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-meta font-medium text-ink">Tasks — one per line</span>
            <textarea
              value={text}
              onChange={e => { setText(e.target.value) }}
              rows={5}
              autoFocus
              placeholder={'Fix the flaky checkout test\nAdd rate limiting to the login endpoint\nUpgrade lodash and fix any breakage'}
              className="rounded-control border border-edge bg-page px-2 py-1.5 text-body text-ink placeholder:text-ink-faint focus:border-focus focus:outline-none"
            />
            <span className={`text-micro ${tooMany ? 'text-error-5' : 'text-ink-faint'}`}>
              {tooMany ? 'Up to 20 tasks at a time' : `${tasks.length} task${tasks.length === 1 ? '' : 's'} — each runs in its own isolated session`}
            </span>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-meta font-medium text-ink">Done when <span className="font-normal text-ink-faint">(optional, applies to every task)</span></span>
            <textarea
              value={acceptance}
              onChange={e => { setAcceptance(e.target.value) }}
              rows={2}
              placeholder="e.g. tests and lint pass; no public API changes"
              className="rounded-control border border-edge bg-page px-2 py-1.5 text-body text-ink placeholder:text-ink-faint focus:border-focus focus:outline-none"
            />
          </label>

          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-meta font-medium text-ink">Deliver as</legend>
            {POLICIES.map(p => (
              <label key={p.id} className="flex items-start gap-2 text-body text-ink">
                <input type="radio" name="policy" value={p.id} checked={policy === p.id} onChange={() => { setPolicy(p.id) }} className="mt-1" />
                <span>{p.label} <span className="text-meta text-ink-muted">— {p.hint}</span></span>
              </label>
            ))}
          </fieldset>

          {error && <p role="alert" className="text-body text-error-5">{error}</p>}

          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-control border border-edge px-3 py-1.5 text-body text-ink hover:border-edge-strong">Cancel</button>
            <button
              type="submit"
              disabled={submitting || !repo || tasks.length === 0 || tooMany}
              className="inline-flex items-center gap-1.5 rounded-control bg-primary-8 px-3 py-1.5 text-body font-medium text-on-primary hover:bg-primary-7 disabled:opacity-40"
            >
              {submitting && <IconLoader2 size={14} stroke={2} className="animate-spin" />}
              Delegate {tasks.length > 0 ? tasks.length : ''} task{tasks.length === 1 ? '' : 's'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
