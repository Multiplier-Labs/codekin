/**
 * The one-line installer for the hosted funnel.
 *
 * Generates a pre-approved pairing token (relay-side, tied to this account)
 * and renders the copy-paste command that installs Codekin AND pairs the
 * machine in one run — the "connect your first machine" step the audit found
 * missing: the old empty state presumed Codekin was already installed and
 * linked to nothing. A second command covers machines that already have
 * Codekin. Tokens are single-use with a 10-minute TTL, so the block shows
 * its expiry and can be regenerated.
 */

import { useState } from 'react'
import { IconCopy, IconCheck, IconTerminal2 } from '@tabler/icons-react'
import { precreatePairing } from './machines'

function CopyBlock({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="mt-2">
      <p className="mb-1 text-meta text-ink-muted">{label}</p>
      <div className="flex items-start gap-1.5">
        <code className="min-w-0 flex-1 break-all rounded-control bg-surface-raised px-2 py-1.5 font-mono text-meta text-ink">
          {command}
        </code>
        <button
          onClick={() => {
            void navigator.clipboard.writeText(command).then(() => {
              setCopied(true)
              setTimeout(() => { setCopied(false) }, 2000)
            })
          }}
          className="flex-shrink-0 rounded-control p-1.5 text-ink-muted transition-colors hover:bg-surface-raised hover:text-ink"
          title="Copy"
        >
          {copied ? <IconCheck size={14} stroke={2} className="text-success-4" /> : <IconCopy size={14} stroke={2} />}
        </button>
      </div>
    </div>
  )
}

export function InstallCommand() {
  const [token, setToken] = useState<string | null>(null)
  const [minutesLeft, setMinutesLeft] = useState(10)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)

  const generate = () => {
    setBusy(true)
    setError(false)
    precreatePairing()
      .then((r) => {
        setToken(r.pairingToken)
        setMinutesLeft(Math.max(1, Math.round((r.expiresAt - Date.now()) / 60_000)))
      })
      .catch(() => { setError(true) })
      .finally(() => { setBusy(false) })
  }

  if (!token) {
    return (
      <div className="mt-3">
        <button
          onClick={generate}
          disabled={busy}
          className="flex items-center gap-1.5 rounded-control bg-primary-8 px-3 py-1.5 text-body font-medium text-on-primary transition-colors hover:bg-primary-7 disabled:opacity-60"
        >
          <IconTerminal2 size={15} stroke={2} />
          {busy ? 'Generating…' : 'Generate install command'}
        </button>
        {error && <p className="mt-1.5 text-meta text-error-4">Could not generate a pairing token — try again.</p>}
      </div>
    )
  }

  const origin = window.location.origin
  return (
    <div className="mt-3">
      <CopyBlock
        label="On a new machine — installs Codekin and pairs it with this account:"
        command={`curl -fsSL codekin.ai/install.sh | bash -s -- --pair ${token} --relay ${origin}`}
      />
      <CopyBlock
        label="Already running Codekin? Pair it directly:"
        command={`codekin relay login --code ${token} --url ${origin}`}
      />
      <p className="mt-2 text-meta text-ink-faint">
        Single use · expires in {minutesLeft} min ·{' '}
        <button onClick={generate} className="text-ink-muted underline underline-offset-2 hover:text-ink">
          generate a new one
        </button>
      </p>
    </div>
  )
}
