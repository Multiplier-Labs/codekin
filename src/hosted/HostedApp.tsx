/**
 * Root of the hosted (app.codekin.ai) build: auth gate → remembered machine
 * → workspace. With nothing to restore: the focused "Connect your computer"
 * surface for an account without a usable machine, otherwise Settings
 * (machines only).
 *
 * Selected by src/main.tsx when VITE_APP_MODE=hosted. The local app
 * (src/App.tsx) is untouched by hosted mode.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { LoginPage } from './LoginPage'
import { decideRestore, fetchMachines, forgetMachine, isUsableMachine, lastMachineId, rememberMachine, type Machine } from './machines'
import { useMachineSetup } from './useMachineSetup'
import { ConnectComputer } from './ConnectComputer'
import { MachineConnect } from './MachineConnect'
import { MachineWorkspace } from './MachineWorkspace'
import { HostedRelayTransport, LocalHttpTransport, setTransport } from '../lib/transport'
import { PairPage } from './PairPage'
import { LinkClaimPage } from './LinkClaimPage'
import { useHostedAuth } from './useHostedAuth'
import { INVITE_ERROR_MESSAGES, consumeJoinedWorkspace, pickWorkspace } from './workspace'
import { InvitePage } from './InvitePage'
import { CreateWorkspaceForm } from './WorkspaceSection'
import { Settings } from '../components/Settings'
import { useSettings } from '../hooks/useSettings'
import type { Settings as SettingsValues } from '../types'

/** Shown to signed-in users whose access has not been granted (yet). */
function PendingPage({ login, onLogout }: { login: string; onLogout: () => void }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-page">
      <div className="w-full max-w-sm rounded-floating border border-edge bg-surface p-8 text-center">
        <h1 className="mb-2 font-mono text-head text-ink">Codekin</h1>
        <p className="mb-2 text-body text-ink">
          Hi <span className="font-mono">{login}</span> — your access request is pending.
        </p>
        <p className="mb-6 text-meta text-ink-muted">
          An administrator needs to approve your account before you can use hosted Codekin.
        </p>
        <button
          onClick={onLogout}
          className="w-full rounded-control border border-edge px-4 py-2.5 text-body text-ink-muted transition hover:bg-surface-raised hover:text-ink"
        >
          Sign out
        </button>
      </div>
    </div>
  )
}

/**
 * Signed in and admitted, but a member of no workspace: removed from the
 * last one, or its workspaces were deleted. Offers to create one when the
 * account may; otherwise explains that someone has to add them.
 */
function NoWorkspacePage({ login, canCreate, onLogout }: { login: string; canCreate: boolean; onLogout: () => void }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-page">
      <div className="w-full max-w-sm rounded-floating border border-edge bg-surface p-8">
        <h1 className="mb-2 text-center font-mono text-head text-ink">Codekin</h1>
        <p className="mb-2 text-center text-body text-ink">
          Hi <span className="font-mono">{login}</span> — you are not in a workspace yet.
        </p>
        <p className="mb-6 text-center text-meta text-ink-muted">
          {canCreate
            ? 'Create one to connect your machines, or ask a workspace admin to add you.'
            : 'Ask a workspace admin to add you.'}
        </p>
        {canCreate && (
          <div className="mb-4">
            <CreateWorkspaceForm />
          </div>
        )}
        <button
          onClick={onLogout}
          className="w-full rounded-control border border-edge px-4 py-2.5 text-body text-ink-muted transition hover:bg-surface-raised hover:text-ink"
        >
          Sign out
        </button>
      </div>
    </div>
  )
}

/** A dismissible line over whatever screen is showing (invitation outcomes). */
function Notice({ tone, children, onDismiss }: { tone: 'success' | 'error'; children: React.ReactNode; onDismiss: () => void }) {
  return (
    <div className="fixed inset-x-0 top-3 z-[60] flex justify-center px-4">
      <div
        role="status"
        className={`flex max-w-lg items-start gap-3 rounded-floating border border-edge-strong bg-surface-raised px-4 py-2.5 text-body shadow-floating ${
          tone === 'success' ? 'text-success-6' : 'text-error-4'
        }`}
      >
        <span className="min-w-0 flex-1">{children}</span>
        <button onClick={onDismiss} aria-label="Dismiss" className="text-meta text-ink-faint transition hover:text-ink-muted">
          ✕
        </button>
      </div>
    </div>
  )
}

/**
 * Home screen when no machine is connected. Decides once, on the first
 * successful machine list, whether this is a first run (no usable machine):
 * if so the first-run surface stays put while setup progresses — a machine
 * coming online is announced there with an Open button, rather than the page
 * jumping to Settings under the user.
 */
function HostedHome({ settings, onUpdate, onOpen, onSignOut, signedInAs }: {
  settings: SettingsValues
  onUpdate: (patch: Partial<SettingsValues>) => void
  onOpen: (machine: Machine) => void
  onSignOut: () => void
  signedInAs: string
}) {
  const setup = useMachineSetup({ pollWhileEmpty: true })
  const [firstRun, setFirstRun] = useState<boolean | null>(null)
  const [view, setView] = useState<'setup' | 'account'>('setup')

  // Latch during render (React's "adjust state while rendering" pattern).
  if (firstRun === null && setup.machines !== null) {
    setFirstRun(!setup.machines.some(isUsableMachine))
  }

  if (firstRun !== false && view === 'setup') {
    return (
      <ConnectComputer
        setup={setup}
        onOpen={onOpen}
        onAccount={() => { setView('account') }}
        onSignOut={onSignOut}
        signedInAs={signedInAs}
      />
    )
  }

  return (
    <Settings
      open
      machinesOnly
      settings={settings}
      onUpdate={onUpdate}
      onClose={() => { /* nothing to close to — this is the whole screen */ }}
      onSwitchMachine={onOpen}
      onSignOut={onSignOut}
      signedInAs={signedInAs}
      machineSetup={setup}
      onBack={firstRun ? () => { setView('setup') } : undefined}
    />
  )
}

export default function HostedApp() {
  const { user, account, initialized, authError, logout, refresh } = useHostedAuth()
  // Back from accepting an invitation: open in the workspace just joined.
  // Read before the workspace is picked below.
  const [joinedId] = useState(consumeJoinedWorkspace)
  const [noticeDismissed, setNoticeDismissed] = useState(false)
  // This tab's workspace, settled once the account is known. Every relay call
  // that is not addressed to a machine carries it (see ./workspace).
  const workspace = useMemo(
    () => (user?.status === 'active' ? pickWorkspace(account.workspaces) : null),
    [user, account],
  )
  const { settings, updateSettings } = useSettings()
  const [selected, setSelected] = useState<Machine | null>(null)
  // The transport is created when a machine is picked and installed before
  // the workspace mounts, so App's very first call already goes to the
  // machine. `phase` gates the connect screen against the workspace.
  const [transport, setLocalTransport] = useState<HostedRelayTransport | null>(null)
  const [phase, setPhase] = useState<'connecting' | 'ready'>('connecting')
  // A remembered connection is reinstated before anything renders, so a reload
  // returns to the chat rather than to Settings. Only the presence of the
  // memory is known synchronously; resolving it takes one request.
  const [restoring, setRestoring] = useState(
    () => lastMachineId() !== null && !['/pair', '/link'].includes(window.location.pathname),
  )

  const selectMachine = useCallback((machine: Machine) => {
    const next = new HostedRelayTransport(machine.id, undefined, machine.displayName)
    next.connect()
    setTransport(next)
    setLocalTransport(next)
    setPhase('connecting')
    setSelected(machine)
    rememberMachine(machine.id)
  }, [])

  // Reconnect to the last machine on load. An offline one is skipped rather
  // than dialled: the reload would land on a connect error instead of the
  // chat, and the machine list at least says what is available.
  useEffect(() => {
    if (!restoring) return
    if (!user || user.status !== 'active') return
    // No workspace means no machines to restore to (and the no-workspace
    // screen renders ahead of the restoring gate).
    if (!workspace) return

    let cancelled = false

    const restore = async () => {
      const id = lastMachineId()
      if (id) {
        try {
          const decision = decideRestore(await fetchMachines(), id)
          if (cancelled) return
          if (decision.action === 'connect') selectMachine(decision.machine)
          else if (decision.action === 'forget') forgetMachine()
        } catch {
          // Fall through to Settings, whose machine list reports the failure.
        }
      }
      if (!cancelled) setRestoring(false)
    }

    void restore()
    return () => { cancelled = true }
  }, [restoring, user, workspace, selectMachine])

  // Return to Settings' machine list. The workspace owns its own teardown on
  // unmount, so when it was showing (phase 'ready') we leave the transport to
  // it; from the connect screen no workspace mounted, so drop the relay
  // transport and restore a local one here.
  const backToMachines = useCallback(() => {
    if (phase === 'connecting') {
      transport?.close()
      setTransport(new LocalHttpTransport())
    }
    setSelected(null)
    setLocalTransport(null)
    setPhase('connecting')
    // Leaving on purpose is also a decision not to be sent back next time.
    forgetMachine()
  }, [phase, transport])

  // Switching machines from Settings goes through the same connect gate a
  // fresh pick does. Installing the new transport here means the outgoing
  // workspace's teardown sees it is no longer the installed one and leaves it
  // alone — see MachineWorkspace.
  const switchMachine = useCallback((machine: Machine) => {
    if (machine.id === selected?.id) return
    selectMachine(machine)
  }, [selected, selectMachine])

  // Before the auth gate: claiming a device-link QR is exactly the case where
  // this browser is not signed in yet.
  if (window.location.pathname === '/link') {
    return <LinkClaimPage />
  }
  // Likewise an invitation: the invitee usually has no account yet.
  if (window.location.pathname === '/invite') {
    return <InvitePage />
  }

  // Latch not resolved yet — render the page background, no flash of login UI
  if (!initialized) {
    return <div className="min-h-screen bg-page" />
  }

  if (!user) {
    return <LoginPage authError={authError} onSignedIn={() => void refresh()} />
  }

  if (user.status !== 'active') {
    return <PendingPage login={user.login} onLogout={() => void logout()} />
  }

  // Invitation outcomes for a signed-in user. A signed-out one sees invite
  // errors on the login page instead.
  const joinedName = joinedId ? account.workspaces.find(w => w.id === joinedId)?.name : undefined
  const notice = noticeDismissed ? null : joinedName ? (
    <Notice tone="success" onDismiss={() => { setNoticeDismissed(true) }}>You joined {joinedName}.</Notice>
  ) : authError && INVITE_ERROR_MESSAGES[authError] ? (
    <Notice tone="error" onDismiss={() => { setNoticeDismissed(true) }}>{INVITE_ERROR_MESSAGES[authError]}</Notice>
  ) : null
  const withNotice = (screen: React.ReactNode) => <>{notice}{screen}</>

  if (!workspace) {
    return withNotice(
      <NoWorkspacePage
        login={user.login}
        canCreate={account.canCreateWorkspaces}
        onLogout={() => void logout()}
      />,
    )
  }

  if (window.location.pathname === '/pair') {
    return <PairPage />
  }

  // Same blank page the auth latch uses: a remembered connection should not
  // flash Settings on its way to the workspace.
  if (restoring) {
    return <div className="min-h-screen bg-page" />
  }

  if (selected && transport) {
    if (phase === 'ready') {
      return (
        <MachineWorkspace
          transport={transport}
          onExit={backToMachines}
          onSwitchMachine={switchMachine}
        />
      )
    }
    return (
      <MachineConnect
        machine={selected}
        transport={transport}
        onBack={backToMachines}
        onConnected={() => { setPhase('ready') }}
      />
    )
  }

  // Not connected to anything: first run gets the focused setup surface;
  // otherwise land in Settings, where the machine list lives once you are
  // connected too.
  return withNotice(
    <HostedHome
      settings={settings}
      onUpdate={updateSettings}
      onOpen={selectMachine}
      onSignOut={() => void logout()}
      signedInAs={`${user.displayName ?? user.login} · ${workspace.name}`}
    />,
  )
}
