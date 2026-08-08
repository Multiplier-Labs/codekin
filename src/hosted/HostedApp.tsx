/**
 * Root of the hosted (app.codekin.ai) build: auth gate → machines view.
 *
 * Selected by src/main.tsx when VITE_APP_MODE=hosted. The local app
 * (src/App.tsx) is untouched by hosted mode.
 */

import { useState } from 'react'
import { LoginPage } from './LoginPage'
import { MachinesPage } from './MachinesPage'
import type { Machine } from './MachinesPage'
import { MachineDetailPage } from './MachineDetailPage'
import { MachineWorkspace } from './MachineWorkspace'
import { HostedRelayTransport, setTransport } from '../lib/transport'
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
  // Set when entering the workspace. Creating the transport here — in an
  // event handler rather than during render — guarantees it is installed
  // before the app mounts and issues its first call.
  const [workspace, setWorkspace] = useState<HostedRelayTransport | null>(null)

  const openWorkspace = (machine: Machine) => {
    const transport = new HostedRelayTransport(machine.id)
    transport.connect()
    setTransport(transport)
    setWorkspace(transport)
  }

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

  if (selected && workspace) {
    return (
      <MachineWorkspace
        machine={selected}
        transport={workspace}
        onExit={() => { setWorkspace(null) }}
      />
    )
  }

  if (selected) {
    return (
      <MachineDetailPage
        machine={selected}
        onBack={() => { setSelected(null) }}
        onOpenWorkspace={() => { openWorkspace(selected) }}
      />
    )
  }

  return <MachinesPage user={user} onLogout={() => void logout()} onSelect={setSelected} />
}
