/**
 * Hosted, no machine connected: the whole screen. Machines first (the one
 * thing to do here is pick or connect a computer), then the account and
 * workspace sections that work without a machine.
 *
 * Everything else in Settings lives in the routed view
 * (src/components/settings/SettingsView.tsx). docs/SETTINGS-VIEW-SPEC.md,
 * PR 3, folds this screen into it as /settings/machines.
 */

import { Suspense, lazy } from 'react'
import { IconServer2, IconDevices, IconUsersGroup, IconShieldCheck } from '@tabler/icons-react'
import { SectionCard } from './settings/SectionCard'

interface Props {
  /** Open a machine. */
  onSwitchMachine: (machine: import('../hosted/machines').Machine) => void
  /** Shown beside the header, where there is no sidebar. */
  onSignOut?: () => void
  /** Who is signed in, for the same header. */
  signedInAs?: string
  /**
   * List/setup state owned by the hosted home screen, so an install command
   * shown there survives the switch here.
   */
  machineSetup?: import('../hosted/useMachineSetup').MachineSetup
  /** Return to the first-run setup surface. */
  onBack?: () => void
}

// Lazy so the local build never loads them.
const MachinesSection = lazy(() => import('../hosted/MachinesSection').then(m => ({ default: m.MachinesSection })))
const DevicesSection = lazy(() => import('../hosted/DevicesSection').then(m => ({ default: m.DevicesSection })))
const WorkspaceSection = lazy(() => import('../hosted/WorkspaceSection').then(m => ({ default: m.WorkspaceSection })))
const TwoFactorPanel = lazy(() => import('../hosted/TwoFactor').then(m => ({ default: m.TwoFactorPanel })))

export function Settings({ onSwitchMachine, onSignOut, signedInAs, machineSetup, onBack }: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-page p-4 sm:items-center">
      <div className="w-full max-w-2xl rounded-floating border border-edge-strong bg-surface-raised shadow-floating">
        <div className="flex items-start justify-between gap-3 border-b border-edge px-6 pt-5 pb-4">
          <div>
            {onBack && (
              <button
                onClick={onBack}
                className="-ml-2 mb-1 rounded-control px-2 py-0.5 text-meta text-ink-muted transition hover:bg-surface hover:text-ink"
              >
                ← Back to setup
              </button>
            )}
            <h2 className="text-head font-semibold text-ink">{onBack ? 'Account' : 'Settings'}</h2>
            <p className="mt-0.5 text-meta text-ink-muted">
              Connect a machine to start working. Everything else lives on the machine.
            </p>
          </div>
          {onSignOut && (
            <div className="flex flex-shrink-0 items-center gap-3">
              {signedInAs && <span className="text-meta text-ink-muted">{signedInAs}</span>}
              <button
                onClick={onSignOut}
                className="rounded-control border border-edge px-3 py-1.5 text-meta text-ink-muted transition hover:bg-surface hover:text-ink"
              >
                Sign out
              </button>
            </div>
          )}
        </div>
        <div className="px-6 py-5">
          <SectionCard icon={<IconServer2 size={15} />} title="Machines">
            <Suspense fallback={<p className="text-body text-ink-muted">Loading…</p>}>
              <MachinesSection currentMachineId="" onSwitch={machine => { onSwitchMachine(machine) }} setup={machineSetup} />
            </Suspense>
          </SectionCard>
          <div className="mt-4">
            <SectionCard icon={<IconUsersGroup size={15} />} title="Workspace">
              <Suspense fallback={<p className="text-body text-ink-muted">Loading…</p>}>
                <WorkspaceSection />
              </Suspense>
            </SectionCard>
          </div>
          <div className="mt-4">
            <SectionCard icon={<IconDevices size={15} />} title="Devices & passkeys">
              <Suspense fallback={<p className="text-body text-ink-muted">Loading…</p>}>
                <DevicesSection />
              </Suspense>
            </SectionCard>
          </div>
          <div className="mt-4">
            <SectionCard icon={<IconShieldCheck size={15} />} title="Two-factor authentication">
              <Suspense fallback={<p className="text-body text-ink-muted">Loading…</p>}>
                <TwoFactorPanel />
              </Suspense>
            </SectionCard>
          </div>
        </div>
      </div>
    </div>
  )
}
