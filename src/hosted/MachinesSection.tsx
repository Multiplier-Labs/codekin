/**
 * The machine list, as a section of Settings.
 *
 * Picking a machine used to be a view you passed through on the way in, and
 * landed back on after every reload. Once the connection is remembered, that
 * view has nothing to say on a normal visit — so the list lives here, beside
 * the other things you change about the session you are already in, and the
 * standalone picker is left to first run.
 *
 * Lazy-loaded by Settings so the local build never pulls it in.
 */

import { useState, useEffect } from 'react'
import { IconCheck } from '@tabler/icons-react'
import { fetchMachines, MACHINE_STATUS_DOT, type Machine } from './machines'

interface MachinesSectionProps {
  /** Machine the workspace is currently connected to. */
  currentMachineId: string
  /** Connect to another machine — tears down this workspace and opens theirs. */
  onSwitch: (machine: Machine) => void
  /**
   * Leave the machine entirely, back to the picker. The only way out now that
   * the workspace has no floating exit button, so it is never hidden behind a
   * hover or a menu.
   */
  onDisconnect?: () => void
}

export function MachinesSection({ currentMachineId, onSwitch, onDisconnect }: MachinesSectionProps) {
  const [machines, setMachines] = useState<Machine[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchMachines()
      .then(list => { if (!cancelled) setMachines(list) })
      .catch(() => { if (!cancelled) { setMachines([]); setFailed(true) } })
    return () => { cancelled = true }
  }, [])

  if (machines === null) {
    return <p className="text-body text-ink-muted">Loading…</p>
  }

  if (failed) {
    return <p className="text-body text-ink-muted">Could not reach the relay to list your machines.</p>
  }

  // Nothing paired yet — the two commands that fix that, since a bare empty
  // list leaves a new user with no next step.
  if (machines.length === 0) {
    return (
      <>
        <p className="mb-2 text-body text-ink">No machines paired yet.</p>
        <p className="text-meta text-ink-muted">
          On a machine running Codekin, run{' '}
          <code className="rounded-control bg-surface-raised px-1.5 py-0.5 font-mono text-meta text-ink">
            codekin relay login
          </code>{' '}
          to pair it, then{' '}
          <code className="rounded-control bg-surface-raised px-1.5 py-0.5 font-mono text-meta text-ink">
            codekin relay connect
          </code>{' '}
          to bring it online.
        </p>
      </>
    )
  }

  const current = machines.find(m => m.id === currentMachineId)

  return (
    <>
    <ul className="flex flex-col gap-1.5">
      {machines.map(m => {
        const isCurrent = m.id === currentMachineId
        // The machine you are on is a statement, not a button — switching to
        // where you already are would tear the workspace down and rebuild it.
        const Row = isCurrent ? 'div' : 'button'
        return (
          <li key={m.id}>
            <Row
              {...(isCurrent
                ? {}
                : {
                    onClick: () => { onSwitch(m) },
                    title: `Connect to ${m.displayName}`,
                  })}
              className={`flex w-full items-center gap-3 rounded-control border px-3 py-2 text-left transition ${
                isCurrent
                  ? 'border-edge-strong bg-surface-raised'
                  : 'border-edge bg-surface hover:bg-surface-raised'
              }`}
            >
              <span className={`h-2 w-2 flex-shrink-0 rounded-full ${MACHINE_STATUS_DOT[m.status]}`} />
              <span className="truncate text-body text-ink">{m.displayName}</span>
              {m.hostname && <span className="truncate text-meta text-ink-faint">{m.hostname}</span>}
              {m.access === 'shared' && (
                <span className="flex-shrink-0 rounded-control border border-edge px-1.5 py-0.5 text-micro text-ink-muted">
                  shared with you
                </span>
              )}
              {isCurrent ? (
                <span className="ml-auto flex flex-shrink-0 items-center gap-1 text-meta text-primary-4">
                  <IconCheck size={14} stroke={2.5} />
                  connected
                </span>
              ) : (
                <span className="ml-auto flex-shrink-0 text-meta text-ink-muted">{m.status}</span>
              )}
            </Row>
          </li>
        )
      })}
    </ul>

    {onDisconnect && (
      <div className="mt-3 border-t border-edge pt-3">
        <button
          onClick={onDisconnect}
          className="rounded-control px-2 py-1 text-meta text-ink-muted transition hover:bg-surface hover:text-ink"
        >
          Disconnect{current ? ` from ${current.displayName}` : ''}
        </button>
        <p className="mt-1 px-2 text-micro text-ink-faint">
          Returns to the machine list, and stops reconnecting here on reload.
        </p>
      </div>
    )}
    </>
  )
}
