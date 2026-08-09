/**
 * Root of the hosted (app.codekin.ai) build: auth gate → machines view.
 *
 * Selected by src/main.tsx when VITE_APP_MODE=hosted. The local app
 * (src/App.tsx) is untouched by hosted mode.
 */

import { useState, useCallback } from 'react'
import { LoginPage } from './LoginPage'
import { MachinesPage } from './MachinesPage'
import type { Machine } from './MachinesPage'
import { MachineConnect } from './MachineConnect'
import { MachineWorkspace } from './MachineWorkspace'
import { HostedRelayTransport, LocalHttpTransport, setTransport } from '../lib/transport'
import { PairPage } from './PairPage'
import { useHostedAuth } from './useHostedAuth'

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
  const [selected, setSelected] = useState<Machine | null>(null)
  // The transport is created when a machine is picked and installed before
  // the workspace mounts, so App's very first call already goes to the
  // machine. `phase` gates the connect screen against the workspace.
  const [transport, setLocalTransport] = useState<HostedRelayTransport | null>(null)
  const [phase, setPhase] = useState<'connecting' | 'ready'>('connecting')

  const selectMachine = (machine: Machine) => {
    const next = new HostedRelayTransport(machine.id)
    next.connect()
    setTransport(next)
    setLocalTransport(next)
    setPhase('connecting')
    setSelected(machine)
  }

  // Return to the machine list. The workspace owns its own teardown on
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
  }, [phase, transport])

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

  if (selected && transport) {
    if (phase === 'ready') {
      return <MachineWorkspace machine={selected} transport={transport} onExit={backToMachines} />
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

  return <MachinesPage user={user} onLogout={() => void logout()} onSelect={selectMachine} />
}
