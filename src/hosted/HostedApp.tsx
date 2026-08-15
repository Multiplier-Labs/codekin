/**
 * Root of the hosted (app.codekin.ai) build: auth gate → remembered machine
 * → workspace, or Settings (machines only) when there is nothing to restore.
 *
 * Selected by src/main.tsx when VITE_APP_MODE=hosted. The local app
 * (src/App.tsx) is untouched by hosted mode.
 */

import { useState, useEffect, useCallback } from 'react'
import { LoginPage } from './LoginPage'
import { decideRestore, fetchMachines, forgetMachine, lastMachineId, rememberMachine, type Machine } from './machines'
import { MachineConnect } from './MachineConnect'
import { MachineWorkspace } from './MachineWorkspace'
import { HostedRelayTransport, LocalHttpTransport, setTransport } from '../lib/transport'
import { PairPage } from './PairPage'
import { useHostedAuth } from './useHostedAuth'
import { Settings } from '../components/Settings'
import { useSettings } from '../hooks/useSettings'

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

export default function HostedApp() {
  const { user, initialized, authError, logout } = useHostedAuth()
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
    () => lastMachineId() !== null && window.location.pathname !== '/pair',
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
  }, [restoring, user, selectMachine])

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

  // Latch not resolved yet — render the page background, no flash of login UI
  if (!initialized) {
    return <div className="min-h-screen bg-page" />
  }

  if (!user) {
    return <LoginPage authError={authError} />
  }

  if (user.status !== 'active') {
    return <PendingPage login={user.login} onLogout={() => void logout()} />
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

  // Not connected to anything: land in Settings, where the machine list lives
  // once you are connected too. One place to manage the connection, whichever
  // side of it you are on.
  return (
    <Settings
      open
      machinesOnly
      settings={settings}
      onUpdate={updateSettings}
      onClose={() => { /* nothing to close to — this is the whole screen */ }}
      onSwitchMachine={selectMachine}
      onSignOut={() => void logout()}
      signedInAs={user.displayName ?? user.login}
    />
  )
}
