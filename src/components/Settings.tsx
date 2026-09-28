/**
 * Settings dialog: the shell that places each section (src/components/settings/*,
 * and the hosted sections under src/hosted/*). Sections own their state and
 * load their own data when they mount; the shell keeps only the access token,
 * which the footer's Save commits, and one line for save errors.
 *
 * docs/SETTINGS-VIEW-SPEC.md moves this to a routed full view.
 */

import { useState, useEffect, Suspense, lazy } from 'react'
import {
  IconKey, IconPalette, IconBrandGithub, IconShieldLock, IconServer2, IconDevices, IconUsersGroup, IconShieldCheck,
} from '@tabler/icons-react'
import type { Settings as SettingsType, Repo } from '../types'
import { verifyToken } from '../lib/ccApi'
import { SectionCard } from './settings/SectionCard'
import { AccessTokenField } from './settings/AccessTokenField'
import { AgentNameField } from './settings/AgentNameField'
import { ThemePicker } from './settings/ThemePicker'
import { SessionPreferences } from './settings/SessionPreferences'
import { PermissionsSection } from './settings/PermissionsSection'
import { WebhooksSection } from './settings/WebhooksSection'

interface Props {
  open: boolean
  onClose: () => void
  settings: SettingsType
  onUpdate: (patch: Partial<SettingsType>) => void
  isMobile?: boolean
  autoWorktree?: boolean
  onAutoWorktreeChange?: (enabled: boolean) => void
  agentName?: string
  onAgentNameChange?: (name: string) => void
  /** Repos used to aggregate app-wide approval counts. */
  repos?: Repo[]
  /** Hosted only: machine this workspace is connected to. */
  hostedMachineId?: string
  /** Hosted only: connect to another machine. Absent in the local build. */
  onSwitchMachine?: (machine: import('../hosted/machines').Machine) => void
  /** Hosted only: leave the current machine and return to the picker. */
  onDisconnectMachine?: () => void
  /**
   * Hosted only: no machine is connected yet, so this is the whole app —
   * only the Machines section, since every other setting lives on a machine
   * and has nothing to read or write until one is chosen.
   */
  machinesOnly?: boolean
  /** Shown beside the header in `machinesOnly` mode, where there is no sidebar. */
  onSignOut?: () => void
  /** Who is signed in, for the same header. */
  signedInAs?: string
  /**
   * Hosted `machinesOnly` mode: list/setup state owned by the hosted home
   * screen, so an install command shown there survives the switch here.
   */
  machineSetup?: import('../hosted/useMachineSetup').MachineSetup
  /** Hosted `machinesOnly` mode: return to the first-run setup surface. */
  onBack?: () => void
}

/**
 * Hosted only: the machine list, which used to be a separate view you landed
 * on. Lazy so the local build never loads it.
 */
const MachinesSection = lazy(() => import('../hosted/MachinesSection').then(m => ({ default: m.MachinesSection })))
const DevicesSection = lazy(() => import('../hosted/DevicesSection').then(m => ({ default: m.DevicesSection })))
const WorkspaceSection = lazy(() => import('../hosted/WorkspaceSection').then(m => ({ default: m.WorkspaceSection })))
const TwoFactorPanel = lazy(() => import('../hosted/TwoFactor').then(m => ({ default: m.TwoFactorPanel })))

export function Settings({ open, onClose, settings, onUpdate, isMobile = false, autoWorktree = false, onAutoWorktreeChange, agentName = 'Joe', onAgentNameChange, repos = [], hostedMachineId = '', onSwitchMachine, onDisconnectMachine, machinesOnly = false, onSignOut, signedInAs, machineSetup, onBack }: Props) {
  const [tokenInput, setTokenInput] = useState(settings.token)
  const [verifying, setVerifying] = useState(false)
  const [status, setStatus] = useState<'idle' | 'valid' | 'invalid'>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)

  // Re-sync token input when settings change or modal reopens
  useEffect(() => { setTokenInput(settings.token); setStatus('idle'); setSaveError(null) }, [settings.token, open]) // eslint-disable-line react-hooks/set-state-in-effect -- sync on reopen

  if (!open) return null

  async function handleVerify() {
    if (!tokenInput.trim()) return
    setVerifying(true)
    setStatus('idle')
    try {
      const valid = await verifyToken(tokenInput.trim())
      setStatus(valid ? 'valid' : 'invalid')
      if (valid) {
        onUpdate({ token: tokenInput.trim() })
      }
    } catch {
      setStatus('invalid')
    } finally {
      setVerifying(false)
    }
  }

  function handleSave() {
    onUpdate({ token: tokenInput.trim() })
    onClose()
  }

  // Hosted, nothing connected: Settings is the whole screen. No dimmed
  // backdrop and no way to dismiss it — there is no app behind it yet, and
  // the one thing to do here is pick a machine.
  if (machinesOnly) {
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
                <MachinesSection currentMachineId="" onSwitch={machine => { onSwitchMachine?.(machine) }} setup={machineSetup} />
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

  return (
    <div className={`fixed inset-0 z-50 flex bg-black/60 ${isMobile ? 'items-end' : 'items-center justify-center'}`}>
      <div className={`w-full bg-surface-raised border border-edge-strong shadow-floating flex flex-col ${isMobile ? 'max-h-[95vh] rounded-t-floating' : 'max-w-2xl rounded-floating max-h-[85vh]'}`}>
        {/* Header */}
        <div className="flex-shrink-0 px-6 pt-5 pb-4 border-b border-edge">
          <h2 className="text-head font-semibold text-ink">Settings</h2>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">

          {/* ── Machines (hosted only) ──
              First, because it says which machine everything below applies to. */}
          {onSwitchMachine && (
            <SectionCard icon={<IconServer2 size={15} />} title="Machines">
              <Suspense fallback={<p className="text-body text-ink-muted">Loading…</p>}>
                <MachinesSection
                  currentMachineId={hostedMachineId}
                  onSwitch={machine => { onClose(); onSwitchMachine(machine) }}
                  onDisconnect={onDisconnectMachine && (() => { onClose(); onDisconnectMachine() })}
                />
              </Suspense>
            </SectionCard>
          )}

          {/* ── Workspace (hosted only) ── */}
          {onSwitchMachine && (
            <SectionCard icon={<IconUsersGroup size={15} />} title="Workspace">
              <Suspense fallback={<p className="text-body text-ink-muted">Loading…</p>}>
                <WorkspaceSection />
              </Suspense>
            </SectionCard>
          )}

          {/* ── Devices & passkeys (hosted only) ── */}
          {onSwitchMachine && (
            <SectionCard icon={<IconDevices size={15} />} title="Devices & passkeys">
              <Suspense fallback={<p className="text-body text-ink-muted">Loading…</p>}>
                <DevicesSection />
              </Suspense>
            </SectionCard>
          )}

          {/* ── Two-factor authentication (hosted only) ── */}
          {onSwitchMachine && (
            <SectionCard icon={<IconShieldCheck size={15} />} title="Two-factor authentication">
              <Suspense fallback={<p className="text-body text-ink-muted">Loading…</p>}>
                <TwoFactorPanel />
              </Suspense>
            </SectionCard>
          )}

          {/* ── Authentication ── */}
          <SectionCard icon={<IconKey size={15} />} title="Authentication">
            <AccessTokenField
              value={tokenInput}
              onChange={value => { setTokenInput(value); setStatus('idle') }}
              verifying={verifying}
              status={status}
              onVerify={() => void handleVerify()}
            />
          </SectionCard>

          {/* ── Preferences ── */}
          <SectionCard icon={<IconPalette size={15} />} title="Preferences">
            <div className="space-y-5">
              <AgentNameField token={settings.token} agentName={agentName} onAgentNameChange={onAgentNameChange} onError={setSaveError} />

              <div className="border-t border-edge" />

              <ThemePicker theme={settings.theme} onSelect={theme => { onUpdate({ theme }) }} />

              <SessionPreferences
                token={settings.token}
                autoWorktree={autoWorktree}
                onAutoWorktreeChange={onAutoWorktreeChange}
                onError={setSaveError}
              />
            </div>
          </SectionCard>

          {/* ── Permissions ── */}
          <SectionCard icon={<IconShieldLock size={15} />} title="Permissions">
            <PermissionsSection token={settings.token} repos={repos} onError={setSaveError} />
          </SectionCard>

          {/* ── GitHub Webhooks ── */}
          <SectionCard icon={<IconBrandGithub size={15} />} title="GitHub Webhooks">
            <WebhooksSection token={settings.token} />
          </SectionCard>
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 px-6 py-4 border-t border-edge flex items-center justify-between">
          <div>
            {saveError && (
              <p className="text-body text-error-5">{saveError}</p>
            )}
          </div>
          <div className="flex gap-2">
            {settings.token && (
              <button
                onClick={onClose}
                className="rounded-control px-4 py-2 text-body text-ink-muted hover:text-ink"
              >
                Cancel
              </button>
            )}
            <button
              onClick={handleSave}
              disabled={!tokenInput.trim()}
              className="rounded-control bg-primary-8 px-4 py-2 text-body font-medium text-on-primary hover:bg-primary-7 disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
