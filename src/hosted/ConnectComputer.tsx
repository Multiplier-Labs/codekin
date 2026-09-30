/**
 * First-run surface for hosted Codekin: "Connect your computer".
 *
 * Shown instead of Settings when the account has no usable machine yet. One
 * job only — explain the model, list what the computer needs, hand over the
 * install command and follow it to "online" — so account administration
 * (devices, passkeys, sign out everywhere) sits behind a small Account link
 * rather than competing with activation.
 *
 * On a phone the command cannot be run where it is shown, so the surface
 * leads with a continue-on-your-computer handoff. The shared link is the
 * bare app URL: a pairing token is a bearer secret and never goes in a link.
 */

import { useState } from 'react'
import { IconDeviceDesktop, IconLink, IconShare, IconUserCircle, IconPlayerPlay } from '@tabler/icons-react'
import { useIsMobile } from '../hooks/useIsMobile'
import { isUsableMachine, type Machine } from './machines'
import type { MachineSetup } from './useMachineSetup'
import { InstallCommand } from './InstallCommand'
import { PairingPanel, PendingSetup, SetupSteps } from './SetupProgress'

/** Below this width the page assumes it is not on the computer being set up. */
const HANDOFF_BREAKPOINT = 640

interface ConnectComputerProps {
  setup: MachineSetup
  /** Enter the workspace on a machine — same path as picking it from the list. */
  onOpen: (machine: Machine) => void
  /** Devices, passkeys, sign-out-everywhere and the full machine list. */
  onAccount: () => void
  onSignOut: () => void
  signedInAs: string
}

const quietButton =
  'flex items-center gap-1.5 rounded-control border border-edge px-3 py-1.5 text-meta text-ink-muted transition hover:bg-surface-raised hover:text-ink'

/** Continue on the computer: copy (or share) a link to this page — never a token. */
function HandoffPanel({ onShowHere }: { onShowHere: () => void }) {
  const [copied, setCopied] = useState(false)
  const url = `${window.location.origin}/`
  const canShare = typeof navigator.share === 'function'
  return (
    <div className="rounded-control border border-edge bg-page px-4 py-3" data-testid="handoff">
      <p className="flex items-center gap-2 text-body font-medium text-ink">
        <IconDeviceDesktop size={18} className="flex-shrink-0 text-ink-muted" />
        Continue on your computer
      </p>
      <p className="mt-1 text-meta text-ink-muted">
        The install command runs in a terminal on the computer you want to code on. Open this page
        there and sign in — then this device can control it too.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={() => {
            void navigator.clipboard.writeText(url).then(() => { setCopied(true) })
          }}
          className={quietButton}
        >
          <IconLink size={14} />
          {copied ? 'Link copied' : 'Copy link to this page'}
        </button>
        {canShare && (
          <button
            onClick={() => {
              navigator.share({ title: 'Codekin', text: 'Connect your computer to Codekin', url }).catch(() => {
                // Dismissing the share sheet rejects; nothing to report.
              })
            }}
            className={quietButton}
          >
            <IconShare size={14} />
            Share…
          </button>
        )}
      </div>
      <button
        onClick={onShowHere}
        className="mt-3 text-meta text-ink-faint underline underline-offset-2 hover:text-ink-muted"
      >
        Show the install command here anyway
      </button>
    </div>
  )
}

function Prerequisites() {
  return (
    <ul className="flex flex-col gap-1 text-meta text-ink-muted">
      <li>
        <span className="text-ink">macOS or Linux.</span> Windows isn't supported yet.
      </li>
      <li>
        <span className="text-ink">Node.js 20 or newer</span> — the installer adds it if it's missing.
      </li>
      <li>
        <span className="text-ink">At least one coding agent</span>, installed and signed in on that
        computer: Claude Code, Codex, or OpenCode.
      </li>
    </ul>
  )
}

export function ConnectComputer({ setup, onOpen, onAccount, onSignOut, signedInAs }: ConnectComputerProps) {
  const narrow = useIsMobile(HANDOFF_BREAKPOINT)
  const [showHere, setShowHere] = useState(false)
  const { machines, pairing } = setup

  const orphan = !pairing ? machines?.find(m => m.setupPending) ?? null : null
  // A machine that became usable some other way (CLI pairing, another tab).
  const usable = !pairing ? machines?.filter(isUsableMachine) ?? [] : []

  let body: React.ReactNode
  if (machines === null) {
    body = setup.loadFailed ? (
      <div role="alert" className="flex flex-wrap items-center gap-3">
        <p className="text-body text-ink-muted">Could not reach Codekin to check your computers.</p>
        <button onClick={() => void setup.refresh()} className={quietButton}>Retry</button>
      </div>
    ) : (
      <p className="text-body text-ink-muted">Loading…</p>
    )
  } else if (usable.length > 0) {
    body = (
      <div className="flex flex-col gap-2">
        <SetupSteps step="online" />
        {usable.map(m => (
          <div key={m.id} className="flex flex-wrap items-center gap-3 rounded-control border border-edge bg-page px-3 py-2">
            <span className="min-w-0 flex-1 truncate text-body text-ink">
              {m.displayName} <span className="text-meta text-ink-muted">· {m.status}</span>
            </span>
            <button
              onClick={() => { onOpen(m) }}
              className="flex items-center gap-1.5 rounded-control bg-primary-8 px-3 py-1.5 text-body font-medium text-on-primary transition-colors hover:bg-primary-7"
            >
              <IconPlayerPlay size={15} stroke={2} />
              Open
            </button>
          </div>
        ))}
      </div>
    )
  } else if (narrow && !showHere) {
    body = <HandoffPanel onShowHere={() => { setShowHere(true) }} />
  } else if (pairing) {
    body = <PairingPanel setup={setup} onOpen={onOpen} />
  } else if (orphan) {
    body = (
      <div className="flex flex-col gap-3">
        <SetupSteps step="waiting" />
        <PendingSetup machine={orphan} setup={setup} />
        {setup.generateError && <p role="alert" className="text-meta text-error-4">{setup.generateError}</p>}
      </div>
    )
  } else {
    body = (
      <div className="flex flex-col gap-1">
        <SetupSteps step={null} />
        <InstallCommand
          pairing={null}
          onGenerate={() => void setup.generate()}
          generating={setup.generating}
          error={setup.generateError}
        />
      </div>
    )
  }

  return (
    <div className="flex min-h-screen flex-col items-center bg-page px-4 py-6 sm:justify-center">
      <div className="w-full max-w-xl">
        <header className="mb-4 flex items-center justify-between gap-3">
          <span className="font-mono text-title text-ink">Codekin</span>
          <div className="flex min-w-0 items-center gap-1">
            <span className="hidden truncate text-meta text-ink-faint sm:inline">{signedInAs}</span>
            <button
              onClick={onAccount}
              className="flex flex-shrink-0 items-center gap-1.5 rounded-control px-2 py-1 text-meta text-ink-muted transition hover:bg-surface hover:text-ink"
              title="Machines, linked devices and passkeys"
            >
              <IconUserCircle size={16} className="flex-shrink-0" />
              Account
            </button>
            <button
              onClick={onSignOut}
              className="flex-shrink-0 rounded-control px-2 py-1 text-meta text-ink-faint transition hover:bg-surface hover:text-ink"
            >
              Sign out
            </button>
          </div>
        </header>

        <main className="rounded-floating border border-edge bg-surface px-5 py-6 sm:px-7">
          <h1 className="text-head font-semibold text-ink">Connect your computer</h1>
          <p className="mt-2 text-body text-ink-muted">
            Codekin runs coding agents on your own computer, next to your code. This browser — or any
            device you link later — controls them from anywhere.
          </p>

          <h2 className="mt-5 mb-1.5 text-meta font-semibold uppercase tracking-wide text-ink-muted">
            What your computer needs
          </h2>
          <Prerequisites />

          <div className="mt-5 border-t border-edge pt-5">{body}</div>
        </main>

        <p className="mt-3 text-center text-micro text-ink-faint">
          Devices, passkeys and sign-out-everywhere are under{' '}
          <button onClick={onAccount} className="underline underline-offset-2 hover:text-ink-muted">
            Account
          </button>
          .
        </p>
      </div>
    </div>
  )
}
