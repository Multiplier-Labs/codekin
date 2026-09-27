/**
 * The pieces of "add a computer" shared by the first-run surface and the
 * Machines section of Settings: the three-step progress indicator, the panel
 * that follows a command this tab generated from "waiting" to "online", and
 * the row for a setup started earlier whose command can no longer be shown.
 */

import { IconCheck, IconCircleCheck, IconPlayerPlay } from '@tabler/icons-react'
import { InstallCommand } from './InstallCommand'
import { formatTimeLeft, type Machine } from './machines'
import type { MachineSetup, SetupStep } from './useMachineSetup'

const STEPS: { id: SetupStep; label: string }[] = [
  { id: 'waiting', label: 'Waiting for installation' },
  { id: 'paired', label: 'Paired' },
  { id: 'online', label: 'Online' },
]

/** Step indicator; `step` null means setup has not started. */
export function SetupSteps({ step }: { step: SetupStep | null }) {
  const active = step ? STEPS.findIndex(s => s.id === step) : -1
  return (
    <ol className="flex flex-wrap items-center gap-x-3 gap-y-1.5" aria-label="Setup progress">
      {STEPS.map((s, i) => {
        // "Online" is the end state: reaching it completes it.
        const done = i < active || (i === active && s.id === 'online')
        const current = i === active && !done
        return (
          <li
            key={s.id}
            aria-current={current ? 'step' : undefined}
            className="flex items-center gap-1.5 text-meta"
          >
            <span
              className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border text-micro ${
                done
                  ? 'border-success-6 bg-success-6 text-ink-inverse'
                  : current
                    ? 'border-primary-6 text-primary-4'
                    : 'border-edge-strong text-ink-faint'
              }`}
            >
              {done ? <IconCheck size={12} stroke={3} /> : i + 1}
            </span>
            <span className={done || current ? 'text-ink' : 'text-ink-faint'}>{s.label}</span>
            {i < STEPS.length - 1 && <span aria-hidden className="ml-1.5 h-px w-4 bg-edge-strong" />}
          </li>
        )
      })}
    </ol>
  )
}

const quietButton =
  'rounded-control border border-edge px-2.5 py-1 text-meta text-ink-muted transition hover:bg-surface-raised hover:text-ink disabled:opacity-50'

/**
 * Follows the command this tab generated. Waiting: the command, with
 * regenerate and cancel. Paired: waiting for the connection. Online: success,
 * and the way in.
 */
export function PairingPanel({ setup, onOpen, showSteps = true }: {
  setup: MachineSetup
  onOpen: (machine: Machine) => void
  showSteps?: boolean
}) {
  const { pairing, pairingMachine: machine, step } = setup
  if (!pairing || !step) return null

  return (
    <div className="flex flex-col gap-3" data-testid="pairing-panel">
      {showSteps && <SetupSteps step={step} />}

      {step === 'waiting' && (
        <div>
          <InstallCommand
            pairing={pairing}
            onGenerate={() => void setup.generate(pairing.machineId)}
            generating={setup.generating}
            error={setup.generateError}
          />
          <p className="mt-2 text-meta text-ink-muted">
            This page updates by itself when the installer finishes — no need to reload.{' '}
            <button
              onClick={() => void setup.remove(pairing.machineId)}
              className="text-ink-muted underline underline-offset-2 hover:text-ink"
            >
              Cancel setup
            </button>
          </p>
          {setup.removeError && <p role="alert" className="mt-1 text-meta text-error-4">{setup.removeError}</p>}
        </div>
      )}

      {step === 'paired' && machine && (
        <div>
          <p className="text-body text-ink">
            <span className="font-medium">{machine.displayName}</span> is paired. Waiting for it to come online…
          </p>
          <p className="mt-1 text-meta text-ink-muted">
            The Codekin service on that computer connects within a few seconds. If it stays offline, run{' '}
            <code className="rounded-control bg-page px-1 py-0.5 font-mono text-meta text-ink">codekin relay status</code>{' '}
            there.
          </p>
        </div>
      )}

      {step === 'online' && machine && (
        <div className="rounded-control border border-success-7/60 bg-surface px-3 py-3">
          <p className="flex items-center gap-2 text-body text-ink">
            <IconCircleCheck size={18} className="flex-shrink-0 text-success-5" />
            <span>
              <span className="font-medium">{machine.displayName}</span> is online and ready.
            </span>
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              onClick={() => { onOpen(machine) }}
              className="flex items-center gap-1.5 rounded-control bg-primary-8 px-3 py-1.5 text-body font-medium text-on-primary transition-colors hover:bg-primary-7"
            >
              <IconPlayerPlay size={15} stroke={2} />
              Open {machine.displayName}
            </button>
            <button onClick={setup.dismissPairing} className={quietButton}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * A setup whose command this tab does not hold (generated before a reload, or
 * in another tab). The token cannot be fetched again, so the choices are a
 * fresh command for the same slot, or cancelling it.
 */
export function PendingSetup({ machine, setup }: {
  machine: Machine
  setup: MachineSetup
}) {
  const left = machine.pairingExpiresAt ? machine.pairingExpiresAt - setup.loadedAt : null
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-control border border-dashed border-edge-strong bg-surface px-3 py-2">
      <span className="h-2 w-2 flex-shrink-0 rounded-full border border-ink-faint" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-body text-ink">Waiting for installation</p>
        <p className="text-meta text-ink-muted">
          The install command was shown earlier and can't be displayed again
          {left !== null && left > 0 ? ` (it expires in ${formatTimeLeft(left)})` : ''}.
        </p>
      </div>
      <div className="flex flex-shrink-0 items-center gap-2">
        <button
          onClick={() => void setup.generate(machine.id)}
          disabled={setup.generating}
          className={quietButton}
        >
          {setup.generating ? 'Generating…' : 'Regenerate'}
        </button>
        <button
          onClick={() => void setup.remove(machine.id)}
          className="rounded-control px-2 py-1 text-meta text-ink-faint transition hover:text-ink-muted"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
