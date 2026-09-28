/**
 * Settings as a full, routed view (`/settings/<section>`, docs/SETTINGS-VIEW-SPEC.md).
 *
 * Sections are grouped by what they apply to — your account, the current
 * workspace (hosted), or the machine this app is talking to. Desktop shows a
 * section nav beside the content; mobile shows the section list first, then
 * one section with a way back. Every section loads its own data when it
 * mounts and saves as you go; there is no global Save.
 */

import { Suspense, lazy, useEffect, useState } from 'react'
import { IconArrowLeft, IconChevronRight, IconX } from '@tabler/icons-react'
import type { Repo, Settings as SettingsType } from '../../types'
import { verifyToken } from '../../lib/ccApi'
import { AccessTokenField } from './AccessTokenField'
import { AgentNameField } from './AgentNameField'
import { ThemePicker } from './ThemePicker'
import { SessionPreferences } from './SessionPreferences'
import { PermissionsSection } from './PermissionsSection'
import { WebhooksSection } from './WebhooksSection'
import {
  SETTINGS_GROUPS, availableSections, resolveSection, unavailableSections, type SettingsSectionId,
} from './sections'

// Hosted sections are lazy so the local build never loads them.
const MachinesSection = lazy(() => import('../../hosted/MachinesSection').then(m => ({ default: m.MachinesSection })))
const DevicesSection = lazy(() => import('../../hosted/DevicesSection').then(m => ({ default: m.DevicesSection })))
const TwoFactorPanel = lazy(() => import('../../hosted/TwoFactor').then(m => ({ default: m.TwoFactorPanel })))
const WorkspaceGeneral = lazy(() => import('../../hosted/WorkspaceSection').then(m => ({ default: m.WorkspaceGeneral })))
const WorkspaceMembers = lazy(() => import('../../hosted/WorkspaceSection').then(m => ({ default: m.WorkspaceMembers })))
const WorkspaceMachines = lazy(() => import('../../hosted/WorkspaceSection').then(m => ({ default: m.WorkspaceMachines })))
const ProfileSection = lazy(() => import('../../hosted/AccountPages').then(m => ({ default: m.ProfileSection })))
const AccountsSection = lazy(() => import('../../hosted/AccountPages').then(m => ({ default: m.AccountsSection })))

interface Props {
  /** From the URL; null for bare /settings. */
  section: string | null
  onNavigate: (section: SettingsSectionId | null, replace?: boolean) => void
  /** Leave Settings (back to where the user was working). */
  onClose: () => void
  settings: SettingsType
  onUpdate: (patch: Partial<SettingsType>) => void
  isMobile?: boolean
  autoWorktree?: boolean
  onAutoWorktreeChange?: (enabled: boolean) => void
  agentName?: string
  onAgentNameChange?: (name: string) => void
  repos?: Repo[]
  /** Hosted only: the machine this app is connected to. */
  hostedMachineId?: string
  /** Hosted only: connect to another machine. Its presence means hosted. */
  onSwitchMachine?: (machine: import('../../hosted/machines').Machine) => void
  /** Hosted only: leave the current machine. */
  onDisconnectMachine?: () => void
  /**
   * Hosted, no machine connected: Settings is the home screen. Machine
   * sections are listed as unavailable, and there is nothing to close to.
   */
  connected?: boolean
  /** Hosted home: machine list/setup state shared with the first-run surface. */
  machineSetup?: import('../../hosted/useMachineSetup').MachineSetup
  /** Hosted home: shown in the header, where there is no sidebar. */
  signedInAs?: string
  onSignOut?: () => void
  /** Hosted home, first run: back to the setup surface. */
  onBack?: () => void
}

/**
 * Hosted: whether the signed-in account is the platform operator (for the
 * Platform group). Null until known — callers must not redirect away from an
 * operator-only section before then.
 */
function useIsOperator(hosted: boolean): boolean | null {
  const [isOperator, setIsOperator] = useState(hosted ? null : false)
  useEffect(() => {
    if (!hosted) return
    fetch('/api/me', { credentials: 'include' })
      .then(res => res.json() as Promise<{ isOperator?: boolean }>)
      .then(data => { setIsOperator(data.isOperator === true) })
      .catch(() => { setIsOperator(false) })
  }, [hosted])
  return isOperator
}

const loading = <p className="text-body text-ink-muted">Loading…</p>

/** A titled block inside a section page. */
function Block({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-control border border-edge bg-surface px-4 py-4">
      {title && <h3 className="mb-3 text-meta font-semibold uppercase tracking-wide text-ink-muted">{title}</h3>}
      {children}
    </section>
  )
}

/** The Connection page: the access token (local) and the agent's name. */
function ConnectionSection({ settings, onUpdate, hosted, agentName, onAgentNameChange, onError }: {
  settings: SettingsType
  onUpdate: Props['onUpdate']
  hosted: boolean
  agentName: string
  onAgentNameChange?: (name: string) => void
  onError: (message: string) => void
}) {
  const [token, setToken] = useState(settings.token)
  const [verifying, setVerifying] = useState(false)
  const [status, setStatus] = useState<'idle' | 'valid' | 'invalid'>('idle')

  const verify = async () => {
    if (!token.trim()) return
    setVerifying(true)
    setStatus('idle')
    try {
      const valid = await verifyToken(token.trim())
      setStatus(valid ? 'valid' : 'invalid')
      if (valid) onUpdate({ token: token.trim() })
    } catch {
      setStatus('invalid')
    } finally {
      setVerifying(false)
    }
  }

  return (
    <div className="space-y-4">
      {!hosted && (
        <Block title="Access token">
          <AccessTokenField
            value={token}
            onChange={value => { setToken(value); setStatus('idle') }}
            verifying={verifying}
            status={status}
            onVerify={() => void verify()}
          />
          {token.trim() && token.trim() !== settings.token && (
            <button
              onClick={() => { onUpdate({ token: token.trim() }) }}
              className="mt-2 text-meta text-ink-muted underline-offset-2 transition hover:text-ink hover:underline"
            >
              Save without verifying
            </button>
          )}
        </Block>
      )}
      {settings.token && (
        <Block title="Agent">
          <AgentNameField token={settings.token} agentName={agentName} onAgentNameChange={onAgentNameChange} onError={onError} />
        </Block>
      )}
    </div>
  )
}

export function SettingsView({
  section, onNavigate, onClose, settings, onUpdate, isMobile = false, autoWorktree = false,
  onAutoWorktreeChange, agentName = 'Joe', onAgentNameChange, repos = [], hostedMachineId = '',
  onSwitchMachine, onDisconnectMachine, connected = true, machineSetup, signedInAs, onSignOut, onBack,
}: Props) {
  const hosted = onSwitchMachine !== undefined
  const isOperator = useIsOperator(hosted)
  const context = { hosted, hasToken: settings.token !== '', connected, isOperator: isOperator === true }
  const available = availableSections(context)
  const unavailable = unavailableSections(context)
  const current = resolveSection(section, available)
  const [error, setError] = useState<{ section: string; message: string } | null>(null)

  // A missing or unavailable section: desktop opens the first one (the
  // machine list when disconnected — the one thing to do there); mobile
  // shows the list (bare /settings). Either way the URL is corrected in place.
  const fallback = isMobile ? null : connected ? (available.at(0)?.id ?? null) : 'machines'
  const settled = isOperator !== null
  const needsRedirect = settled && current === null && (section !== null || fallback !== null)
  useEffect(() => {
    if (needsRedirect) onNavigate(fallback, true)
  }, [needsRedirect, fallback, onNavigate])

  const showNav = !isMobile || current === null
  const showContent = current !== null
  const def = available.find(s => s.id === current)
  const onError = (message: string) => { if (current) setError({ section: current, message }) }

  const nav = (
    <nav aria-label="Settings sections" className={isMobile ? 'px-3 py-3' : 'w-56 shrink-0 overflow-y-auto border-r border-edge bg-surface px-2 py-3'}>
      {SETTINGS_GROUPS.map(group => {
        const items = available.filter(s => s.group === group)
        const offline = unavailable.filter(s => s.group === group)
        if (items.length === 0 && offline.length === 0) return null
        return (
          <div key={group} className="mb-4">
            <p className="px-3 pb-1 text-micro font-semibold uppercase tracking-wide text-ink-faint">{group}</p>
            {offline.length > 0 && (
              <p className="px-3 pb-1 text-micro text-ink-faint">Connect a machine to change these.</p>
            )}
            {offline.map(item => {
              const Icon = item.icon
              return (
                <div key={item.id} aria-disabled="true" className="density-row flex w-full items-center gap-2 px-3 text-body text-ink-faint">
                  <Icon size={16} className="shrink-0" />
                  <span className="flex-1 truncate">{item.label}</span>
                </div>
              )
            })}
            {items.map(item => {
              const active = item.id === current
              const Icon = item.icon
              return (
                <button
                  key={item.id}
                  onClick={() => { onNavigate(item.id) }}
                  aria-current={active ? 'page' : undefined}
                  className={`density-row flex w-full items-center gap-2 rounded-control px-3 text-left text-body transition-colors ${
                    active ? 'bg-surface-raised text-ink' : 'text-ink-muted hover:bg-surface-raised hover:text-ink'
                  }`}
                >
                  <Icon size={16} className="shrink-0" />
                  <span className="flex-1 truncate">{item.label}</span>
                  {isMobile && <IconChevronRight size={14} className="text-ink-faint" />}
                </button>
              )
            })}
          </div>
        )
      })}
    </nav>
  )

  let body: React.ReactNode = null
  switch (current) {
    case 'profile':
      body = <Block><Suspense fallback={loading}><ProfileSection /></Suspense></Block>
      break
    case 'accounts':
      body = <Block><Suspense fallback={loading}><AccountsSection /></Suspense></Block>
      break
    case 'security':
      body = (
        <div className="space-y-4">
          <Block title="Two-factor authentication"><Suspense fallback={loading}><TwoFactorPanel /></Suspense></Block>
          <Block title="Devices & passkeys"><Suspense fallback={loading}><DevicesSection /></Suspense></Block>
        </div>
      )
      break
    case 'appearance':
      body = <Block><ThemePicker theme={settings.theme} onSelect={theme => { onUpdate({ theme }) }} /></Block>
      break
    case 'workspace':
      body = <Block><Suspense fallback={loading}><WorkspaceGeneral /></Suspense></Block>
      break
    case 'members':
      body = <Block><Suspense fallback={loading}><WorkspaceMembers /></Suspense></Block>
      break
    case 'machines':
      body = (
        <div className="space-y-4">
          <Block title="Your machines">
            <Suspense fallback={loading}>
              <MachinesSection
                currentMachineId={hostedMachineId}
                onSwitch={machine => { onSwitchMachine?.(machine) }}
                onDisconnect={onDisconnectMachine}
                setup={machineSetup}
              />
            </Suspense>
          </Block>
          {/* Renders only for owners and admins. */}
          <Suspense fallback={null}><WorkspaceMachines /></Suspense>
        </div>
      )
      break
    case 'connection':
      body = (
        <ConnectionSection
          settings={settings}
          onUpdate={onUpdate}
          hosted={hosted}
          agentName={agentName}
          onAgentNameChange={onAgentNameChange}
          onError={onError}
        />
      )
      break
    case 'sessions':
      body = (
        <Block>
          <div className="space-y-5">
            <SessionPreferences token={settings.token} autoWorktree={autoWorktree} onAutoWorktreeChange={onAutoWorktreeChange} onError={onError} />
          </div>
        </Block>
      )
      break
    case 'permissions':
      body = <Block><PermissionsSection token={settings.token} repos={repos} onError={onError} /></Block>
      break
    case 'webhooks':
      body = <Block><WebhooksSection token={settings.token} /></Block>
      break
    case null:
      break
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-page">
      <header className="flex shrink-0 items-center gap-2 border-b border-edge px-4 py-3">
        {isMobile && showContent ? (
          <button onClick={() => { onNavigate(null) }} className="flex items-center gap-1 rounded-control px-1.5 py-1 text-body text-ink-muted transition hover:bg-surface-raised hover:text-ink">
            <IconArrowLeft size={16} /> Settings
          </button>
        ) : (
          <div className="flex items-center gap-2">
            {onBack && (
              <button onClick={onBack} className="rounded-control px-1.5 py-1 text-meta text-ink-muted transition hover:bg-surface-raised hover:text-ink">
                ← Back to setup
              </button>
            )}
            <h1 className="text-title font-semibold text-ink">Settings</h1>
          </div>
        )}
        <div className="flex-1" />
        {connected ? (
          <button onClick={onClose} aria-label="Close settings" title="Close settings" className="rounded-control p-1.5 text-ink-muted transition hover:bg-surface-raised hover:text-ink">
            <IconX size={18} />
          </button>
        ) : (
          // The home screen: nothing to close to; who is signed in, and the way out.
          <div className="flex items-center gap-3">
            {signedInAs && <span className="hidden text-meta text-ink-muted sm:inline">{signedInAs}</span>}
            {onSignOut && (
              <button onClick={onSignOut} className="rounded-control border border-edge px-3 py-1.5 text-meta text-ink-muted transition hover:bg-surface-raised hover:text-ink">
                Sign out
              </button>
            )}
          </div>
        )}
      </header>
      <div className="flex min-h-0 flex-1">
        {showNav && nav}
        {showContent && def && (
          <main className="min-w-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-2xl px-4 py-5 sm:px-6">
              <h2 className="mb-4 text-head font-semibold text-ink">{def.label}</h2>
              {error?.section === current && (
                <p role="alert" className="mb-4 rounded-control border border-error-9/50 bg-error-9/10 px-3 py-2 text-body text-error-5">
                  {error.message}
                </p>
              )}
              {/* Keyed so each section mounts fresh — and loads its own data. */}
              <div key={current}>{body}</div>
            </div>
          </main>
        )}
      </div>
    </div>
  )
}
