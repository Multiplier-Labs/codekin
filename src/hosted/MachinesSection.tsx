/**
 * The machine list, as a section of Settings.
 *
 * Picking a machine used to be a view you passed through on the way in, and
 * landed back on after every reload. Once the connection is remembered, that
 * view has nothing to say on a normal visit — so the list lives here, beside
 * the other things you change about the session you are already in, and the
 * first-run "Connect your computer" surface covers the very first visit.
 *
 * "Add computer" is always available — an owned or shared machine never takes
 * away the way to add another. A setup that has not finished is shown as
 * such, with regenerate/cancel, rather than as an ordinary offline machine.
 *
 * Lazy-loaded by Settings so the local build never pulls it in.
 */

import { useCallback, useEffect, useState } from 'react'
import { IconCheck, IconPlus, IconShieldCheck, IconTrash } from '@tabler/icons-react'
import { TrustSheet } from './TrustSheet'
import { currentUserId, deviceTrustSupported, machinePin, removeFromMachine } from './deviceTrust'
import { createIntentSigner } from './intentSigner'
import { RelayConnection } from '../lib/transport/relay-client'
import { MACHINE_STATUS_DOT, type Machine } from './machines'
import { useMachineSetup, type MachineSetup } from './useMachineSetup'
import { InstallCommand } from './InstallCommand'
import { PairingPanel, PendingSetup } from './SetupProgress'
import { Row, button, dangerButton, quietButton } from '../components/settings/Block'

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
  /**
   * Shared list/setup state, when a parent owns it (the hosted home screen,
   * so a command generated on the first-run surface survives the switch to
   * Settings). Without it the section keeps its own.
   */
  setup?: MachineSetup
}

export function MachinesSection(props: MachinesSectionProps) {
  return props.setup ? <MachinesView {...props} setup={props.setup} /> : <OwnMachinesSection {...props} />
}

function OwnMachinesSection(props: MachinesSectionProps) {
  const setup = useMachineSetup()
  return <MachinesView {...props} setup={setup} />
}

const inlineCode = 'rounded-control bg-page px-1.5 py-0.5 font-mono text-meta text-ink'

/**
 * Which machines this browser has been confirmed on (a pinned machine key in
 * IndexedDB). Null while unknown, or where the browser can't hold a key.
 */
function useTrustedMachines(machineIds: string[]): { trusted: Set<string> | null; refresh: () => void } {
  const [trusted, setTrusted] = useState<Set<string> | null>(null)
  const key = machineIds.join(',')
  const refresh = useCallback(() => {
    if (!deviceTrustSupported()) return
    void (async () => {
      const userId = await currentUserId()
      if (!userId) return
      const ids = key ? key.split(',') : []
      const pins = await Promise.all(ids.map(id => machinePin(userId, id).catch(() => undefined)))
      setTrusted(new Set(ids.filter((_, i) => pins[i])))
    })()
  }, [key])
  useEffect(() => { refresh() }, [refresh])
  return { trusted, refresh }
}

/** Ask the machine to drop this browser, then forget it here. */
async function removeThisBrowser(machineId: string): Promise<void> {
  const userId = await currentUserId()
  if (!userId) throw new Error('Sign in again first')
  const conn = new RelayConnection({ machineId })
  try {
    conn.connect()
    const signer = createIntentSigner(machineId)
    await removeFromMachine((kind, payload) => conn.enrol(kind, payload), intent => signer.sign(intent), { userId, machineId })
  } finally {
    conn.close()
  }
}

/** "Confirmed on this browser", or the way to get there (signed-intents spec §6.9). */
function TrustLine({ machine, trusted, onTrusted }: { machine: Machine; trusted: boolean; onTrusted: () => void }) {
  const [open, setOpen] = useState(false)
  const [removing, setRemoving] = useState<'confirm' | 'busy' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const remove = async () => {
    setRemoving('busy')
    setError(null)
    try {
      await removeThisBrowser(machine.id)
      onTrusted()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't remove this browser")
    } finally {
      setRemoving(null)
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2 pl-8 pt-0.5 text-meta">
      {trusted ? (
        <>
          <span className="flex items-center gap-1 text-ink-muted"><IconShieldCheck size={14} /> Confirmed on this browser</span>
          {removing === 'confirm' ? (
            <>
              <button type="button" onClick={() => { void remove() }} className="text-error-4 hover:underline">Remove it from {machine.displayName}</button>
              <button type="button" onClick={() => { setRemoving(null) }} className="text-ink-muted hover:underline">Keep</button>
            </>
          ) : (
            <button type="button" disabled={removing === 'busy'} onClick={() => { setRemoving('confirm') }} className="text-ink-faint hover:text-ink hover:underline">
              {removing === 'busy' ? 'Removing…' : 'Remove this browser'}
            </button>
          )}
          {error && <span className="text-warning-5">{error}</span>}
        </>
      ) : (
        <>
          <span className="text-ink-faint">Not confirmed on this browser</span>
          <button type="button" onClick={() => { setOpen(true) }} className="text-primary-5 hover:underline">Confirm this browser</button>
        </>
      )}
      {open && (
        <TrustSheet
          machineId={machine.id}
          machineName={machine.displayName}
          onTrusted={onTrusted}
          onClose={() => { setOpen(false) }}
        />
      )}
    </div>
  )
}

function MachineRow({ machine: m, isCurrent, onSwitch, setup, gutter, trusted, onTrusted }: {
  machine: Machine
  isCurrent: boolean
  /** Some row has a Remove button: keep a column for it so rows line up. */
  gutter: boolean
  onSwitch: (machine: Machine) => void
  setup: MachineSetup
  /** Whether this browser is confirmed on the machine; null when unknown or not applicable. */
  trusted: boolean | null
  onTrusted: () => void
}) {
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  // The machine you are on is a statement, not a button — switching to
  // where you already are would tear the workspace down and rebuild it.
  const Row = isCurrent ? 'div' : 'button'
  // Removing the machine you are on would pull the floor out from under the
  // workspace; disconnect first. Shared machines are not yours to remove.
  const canRemove = m.access === 'owner' && !isCurrent
  return (
    <li>
      <div className="flex items-center gap-1">
        <Row
          {...(isCurrent
            ? {}
            : {
                onClick: () => { onSwitch(m) },
                title: `Connect to ${m.displayName}`,
              })}
          className={`flex min-w-0 flex-1 items-center gap-3 rounded-control border px-3 py-2 text-left transition ${
            isCurrent
              ? 'border-edge-strong bg-surface-raised'
              : 'border-edge bg-surface hover:bg-surface-raised'
          }`}
        >
          <span className={`h-2 w-2 flex-shrink-0 rounded-full ${MACHINE_STATUS_DOT[m.status]}`} />
          <span className="truncate text-body text-ink">{m.displayName}</span>
          {m.hostname && <span className="truncate text-meta text-ink-muted">{m.hostname}</span>}
          {m.updateRequired && (
            <span
              className="flex-shrink-0 rounded-control border border-warning-7/60 px-1.5 py-0.5 text-meta text-warning-5"
              title={`Needs Codekin ${m.updateRequired.minimum} or later: ${m.updateRequired.reason}. Run \`codekin upgrade\` on it; the desktop app updates itself.`}
            >
              update required
            </span>
          )}
          {m.access === 'shared' && (
            <span className="flex-shrink-0 rounded-control border border-edge px-1.5 py-0.5 text-meta text-ink-muted">
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
        {canRemove ? (
          <button
            onClick={() => { setConfirmingRemove(c => !c) }}
            title={`Remove ${m.displayName}`}
            aria-label={`Remove ${m.displayName}`}
            aria-expanded={confirmingRemove}
            className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-control transition hover:bg-surface-raised hover:text-error-4 ${
              confirmingRemove ? 'text-error-4' : 'text-ink-muted'
            }`}
          >
            <IconTrash size={16} />
          </button>
        ) : gutter && <span aria-hidden className="w-8 flex-shrink-0" />}
      </div>
      {trusted !== null && <TrustLine machine={m} trusted={trusted} onTrusted={onTrusted} />}
      {canRemove && confirmingRemove && (
        <ConfirmRemove machine={m} setup={setup} onClose={() => { setConfirmingRemove(false) }} />
      )}
    </li>
  )
}

/** Remove, behind a confirmation that says what removal actually does. */
function ConfirmRemove({ machine, setup, onClose }: { machine: Machine; setup: MachineSetup; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <div className="mt-1.5 rounded-control border border-error-7/60 bg-page px-3 py-2.5" role="group" aria-label="Confirm removal">
      <p className="text-body text-ink">
        Remove <span className="font-medium">{machine.displayName}</span>? This revokes the credential its
        connector uses, so it disconnects now and has to be paired again to come back.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={() => {
            setBusy(true)
            void setup.remove(machine.id).then(ok => {
              setBusy(false)
              if (ok) onClose()
            })
          }}
          disabled={busy}
          className={dangerButton}
        >
          {busy ? 'Removing…' : 'Remove'}
        </button>
        <button
          onClick={onClose}
          disabled={busy}
          className={quietButton}
        >
          Keep it
        </button>
      </div>
    </div>
  )
}

function RetryButton({ setup }: { setup: MachineSetup }) {
  return (
    <button
      onClick={() => void setup.refresh()}
      className={button}
    >
      Retry
    </button>
  )
}

function MachinesView({ currentMachineId, onSwitch, onDisconnect, setup }: MachinesSectionProps & { setup: MachineSetup }) {
  const { machines, pairing } = setup
  // Only owners enrol browsers on a machine; shared machines have no trust line.
  const { trusted, refresh: refreshTrust } = useTrustedMachines(
    (machines ?? []).filter(m => !m.setupPending && m.access === 'owner').map(m => m.id),
  )

  if (machines === null) {
    if (setup.loadFailed) {
      return (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-body text-ink-muted">Could not reach the relay to list your machines.</p>
          <RetryButton setup={setup} />
        </div>
      )
    }
    return <p className="text-body text-ink-muted">Loading…</p>
  }

  // The machine a displayed command is setting up is followed by the panel
  // below, not listed twice.
  const listed = machines.filter(m => m.id !== pairing?.machineId)
  const pending = listed.filter(m => m.setupPending)
  const ready = listed.filter(m => !m.setupPending)
  const current = machines.find(m => m.id === currentMachineId)
  const gutter = ready.some(m => m.access === 'owner' && m.id !== currentMachineId)

  return (
    <>
      {setup.loadFailed && (
        <div role="alert" className="mb-3 flex flex-wrap items-center gap-3 rounded-control border border-warning-7/60 bg-surface px-3 py-2">
          <p className="text-meta text-ink-muted">Could not refresh the machine list.</p>
          <RetryButton setup={setup} />
        </div>
      )}

      {ready.length === 0 && pending.length === 0 && !pairing && (
        <p className="mb-2 text-body text-ink">No machines paired yet.</p>
      )}

      {ready.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {ready.map(m => (
            <MachineRow
              key={m.id}
              machine={m}
              isCurrent={m.id === currentMachineId}
              onSwitch={onSwitch}
              setup={setup}
              gutter={gutter}
              trusted={trusted && m.access === 'owner' ? trusted.has(m.id) : null}
              onTrusted={refreshTrust}
            />
          ))}
        </ul>
      )}

      {pending.length > 0 && (
        <ul className={`flex flex-col gap-1.5 ${ready.length > 0 ? 'mt-1.5' : ''}`}>
          {pending.map(m => (
            <li key={m.id} className="flex items-center gap-1">
              <div className="min-w-0 flex-1"><PendingSetup machine={m} setup={setup} /></div>
              {gutter && <span aria-hidden className="w-8 flex-shrink-0" />}
            </li>
          ))}
        </ul>
      )}

      {setup.removeError && !pairing && <p role="alert" className="mt-2 text-meta text-error-4">{setup.removeError}</p>}

      <div className={ready.length > 0 || pending.length > 0 ? 'mt-4 border-t border-edge pt-1' : ''}>
        {pairing ? (
          <PairingPanel setup={setup} onOpen={onSwitch} />
        ) : (
          <AddComputer setup={setup} />
        )}
      </div>

      {machines.length === 0 && !pairing && (
        <p className="mt-3 text-meta text-ink-muted">
          Or, on a machine already running Codekin: run{' '}
          <code className={inlineCode}>codekin relay login</code> to pair it.
        </p>
      )}

      {onDisconnect && (
        <div className="border-t border-edge">
          <Row
            label="Leave this machine"
            description="Returns to the machine list, and stops reconnecting here on reload."
            control={
              <button onClick={onDisconnect} className={button}>
                Disconnect{current ? ` from ${current.displayName}` : ''}
              </button>
            }
          />
        </div>
      )}
    </>
  )
}

/** Entry point for another computer: one button, which becomes the command. */
function AddComputer({ setup }: { setup: MachineSetup }) {
  const [open, setOpen] = useState(false)

  if (!open) {
    return (
      <Row
        label="Add a computer"
        description="Generates a one-line install command to run on the computer (macOS or Linux)."
        control={
          <button
            onClick={() => {
              setOpen(true)
              void setup.generate()
            }}
            disabled={setup.generating}
            className={button}
          >
            <IconPlus size={16} stroke={2} />
            Add computer
          </button>
        }
      />
    )
  }

  // Generation failed (or is still running): the command block shows the
  // button and the reason.
  return (
    <InstallCommand
      pairing={null}
      onGenerate={() => void setup.generate()}
      generating={setup.generating}
      error={setup.generateError}
    />
  )
}
