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
import { LocalHttpTransport, setTransport, transport as activeTransport } from '../lib/transport'
import type { HostedRelayTransport } from '../lib/transport'
import type { Machine } from './machines'

const App = lazy(() => import('../App.tsx'))

interface MachineWorkspaceProps {
  transport: HostedRelayTransport
  /** Leave this machine for the picker — offered by the Machines section. */
  onExit: () => void
  /** Connect to a different machine, from the Machines section of Settings. */
  onSwitchMachine: (machine: Machine) => void
}

export function MachineWorkspace({ transport, onExit, onSwitchMachine }: MachineWorkspaceProps) {
  useEffect(() => {
    return () => {
      transport.close()
      // Leave a working transport behind so any late call fails locally
      // rather than against a closed relay connection — but only if ours is
      // still the installed one. Switching machines installs the next
      // machine's transport before this teardown runs, and clobbering it here
      // would point the new workspace's first calls at localhost.
      if (activeTransport === transport) setTransport(new LocalHttpTransport())
    }
  }, [transport])

  // No wrapper element around App: `html, body, #root` are height:100% and
  // App's root is `h-full`, so an intermediate box without a resolved height
  // collapses the whole layout — the sidebar loses its width and the
  // transcript stops scrolling.
  //
  // Nothing is rendered over the app any more. Which machine you are on, and
  // leaving it, both live in the Machines section of Settings — a floating
  // button for it sat on top of the transcript on every screen, to say
  // something that changes once a session.
  return (
    <Suspense fallback={<div className="h-full bg-page" />}>
      <App onSwitchMachine={onSwitchMachine} onDisconnectMachine={onExit} />
    </Suspense>
  )
}
