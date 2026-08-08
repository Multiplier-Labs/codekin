/**
 * The hosted workspace: the full Codekin app, running against a paired
 * machine over the relay.
 *
 * Nothing about the app is hosted-specific — installing the relay transport
 * is what makes chat, approvals, and diffs work remotely, because every REST
 * call and the session WebSocket already go through the transport. The
 * transport is installed by the caller before this mounts, so App's very
 * first fetch already goes to the machine; this component owns its teardown.
 */

import { useEffect, Suspense, lazy } from 'react'
import { LocalHttpTransport, setTransport } from '../lib/transport'
import type { HostedRelayTransport } from '../lib/transport'
import type { Machine } from './MachinesPage'

const App = lazy(() => import('../App.tsx'))

interface MachineWorkspaceProps {
  machine: Machine
  transport: HostedRelayTransport
  onExit: () => void
}

export function MachineWorkspace({ machine, transport, onExit }: MachineWorkspaceProps) {
  useEffect(() => {
    return () => {
      transport.close()
      // Leave a working transport behind so any late call fails locally
      // rather than against a closed relay connection.
      setTransport(new LocalHttpTransport())
    }
  }, [transport])

  // No wrapper element around App: `html, body, #root` are height:100% and
  // App's root is `h-full`, so an intermediate box without a resolved height
  // collapses the whole layout — the sidebar loses its width and the
  // transcript stops scrolling. The exit button is `fixed`, so it needs no
  // positioned parent and can sit alongside App rather than around it.
  return (
    <>
      <Suspense fallback={<div className="h-full bg-page" />}>
        <App />
      </Suspense>

      <button
        onClick={onExit}
        title={`Connected to ${machine.displayName}`}
        className="fixed bottom-3 left-3 z-50 flex items-center gap-2 rounded-control border border-edge-strong bg-surface-raised px-3 py-1.5 text-meta text-ink-muted shadow-floating transition hover:text-ink"
      >
        ← <span className="font-mono">{machine.displayName}</span>
      </button>
    </>
  )
}
