/**
 * The first-run environment checklist (audit N1).
 *
 * The landing surface's live answer to "will this actually work?": one row
 * per agent CLI (installed? signed in? — from the agent-health store the
 * server probes at boot), plus the GitHub CLI and the repository root. Every
 * row is a real check with the exact fix next to it, replacing the silent
 * failure-at-session-start the audit called out.
 *
 * Compact when everything is green (a single "all ready" line — returning
 * users shouldn't stare at a checklist); expands into a card whenever
 * anything needs attention.
 */

import { IconCircleCheck, IconAlertTriangle, IconCircleX, IconCircleDashed } from '@tabler/icons-react'
import { useAgentHealth } from '../hooks/useAgentHealth'
import { buildChecklist, hasUsableAgent, type ChecklistState } from '../lib/environmentChecklist'

const STATE_ICON: Record<ChecklistState, { icon: typeof IconCircleCheck; className: string }> = {
  ready: { icon: IconCircleCheck, className: 'text-success-4' },
  warn: { icon: IconAlertTriangle, className: 'text-warning-4' },
  missing: { icon: IconCircleX, className: 'text-ink-faint' },
  unknown: { icon: IconCircleDashed, className: 'text-ink-faint' },
}

interface Props {
  ghMissing: boolean
  repoCount: number
}

export function EnvironmentChecklist({ ghMissing, repoCount }: Props) {
  const health = useAgentHealth()
  const rows = buildChecklist(health, ghMissing, repoCount)
  const problems = rows.filter((r) => r.state !== 'ready')
  const agentsReady = rows.filter((r) => r.state === 'ready' && ['claude', 'opencode', 'codex'].includes(r.id)).length

  if (problems.length === 0) {
    return (
      <p className="mb-4 flex items-center justify-center gap-1.5 text-meta text-ink-faint">
        <IconCircleCheck size={14} stroke={2} className="text-success-4" />
        {agentsReady} agent{agentsReady === 1 ? '' : 's'} ready · GitHub CLI ✓ · {repoCount} repositories
      </p>
    )
  }

  return (
    <div className="mb-5 rounded-control border border-edge bg-surface px-4 py-3">
      <p className="mb-2 text-meta font-medium text-ink-muted">Environment</p>
      {!hasUsableAgent(rows) && health && (
        <p className="mb-2 text-body text-warning-4">
          No coding agent is available on this host — install at least one to use Codekin.
        </p>
      )}
      <ul className="flex flex-col gap-1.5">
        {rows.map((row) => {
          const { icon: Icon, className } = STATE_ICON[row.state]
          return (
            <li key={row.id} className="flex items-start gap-2 text-body">
              <Icon size={16} stroke={2} className={`mt-0.5 flex-shrink-0 ${className}`} />
              <span className={row.state === 'missing' ? 'text-ink-muted' : 'text-ink'}>{row.label}</span>
              {row.detail && (
                <span className="min-w-0 flex-1 text-meta text-ink-muted">{row.detail}</span>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
