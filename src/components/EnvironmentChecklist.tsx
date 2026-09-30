/**
 * The first-run environment checklist (audits N1, N6).
 *
 * The landing surface's live answer to "will this actually work?": one row
 * per agent CLI (installed? signed in? — from the agent-health store the
 * server probes at boot), plus the optional GitHub CLI and the repository
 * root. Every row is a real check with the exact fix next to it, replacing
 * the silent failure-at-session-start the audit called out.
 *
 * Compact when the environment is usable (one signed-in agent and
 * repositories found) — returning users shouldn't stare at a checklist, and
 * optional agents or an unconnected GitHub CLI shouldn't force it open. The
 * compact line expands to the full list on click.
 */

import { useState } from 'react'
import { IconCircleCheck, IconAlertTriangle, IconCircleX, IconCircleDashed } from '@tabler/icons-react'
import { useAgentHealth } from '../hooks/useAgentHealth'
import {
  buildChecklist,
  hasUsableAgent,
  isEnvironmentReady,
  readyAgentCount,
  type ChecklistEnv,
  type ChecklistState,
} from '../lib/environmentChecklist'

const STATE_ICON: Record<ChecklistState, { icon: typeof IconCircleCheck; className: string }> = {
  ready: { icon: IconCircleCheck, className: 'text-success-4' },
  warn: { icon: IconAlertTriangle, className: 'text-warning-4' },
  missing: { icon: IconCircleX, className: 'text-ink-faint' },
  unknown: { icon: IconCircleDashed, className: 'text-ink-faint' },
}

type Props = ChecklistEnv

export function EnvironmentChecklist(env: Props) {
  const health = useAgentHealth()
  const [expanded, setExpanded] = useState(false)
  const rows = buildChecklist(health, env)
  const agentsReady = readyAgentCount(rows)

  if (isEnvironmentReady(rows) && !expanded) {
    const gh = env.ghStatus === 'ok' ? 'GitHub CLI ✓' : 'GitHub CLI not connected (optional)'
    return (
      <button
        type="button"
        onClick={() => { setExpanded(true) }}
        title="Show environment details"
        className="mx-auto mb-4 flex items-center justify-center gap-1.5 rounded-control px-2 text-meta text-ink-faint transition-colors hover:text-ink-muted"
      >
        <IconCircleCheck size={14} stroke={2} className="text-success-4" />
        {agentsReady} agent{agentsReady === 1 ? '' : 's'} ready · {gh} · {env.repoCount} repositories
      </button>
    )
  }

  return (
    <div className="mb-5 rounded-control border border-edge bg-surface px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-meta font-medium text-ink-muted">Environment</p>
        {expanded && (
          <button type="button" onClick={() => { setExpanded(false) }} className="text-meta text-ink-faint hover:text-ink-muted">
            Hide
          </button>
        )}
      </div>
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
