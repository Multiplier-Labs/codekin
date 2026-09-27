/**
 * The one-line installer for the hosted funnel.
 *
 * Renders the copy-paste command that installs Codekin AND pairs the machine
 * in one run, plus a second command for machines that already have Codekin.
 * The pairing token behind both is single-use with a 10-minute TTL, so the
 * block counts down live and, once expired, hides the stale command and
 * offers a fresh one instead of leaving a valid-looking dead command on
 * screen.
 *
 * Presentational: the token itself is owned by useMachineSetup, which keeps
 * it in memory only.
 */

import { useState, useEffect } from 'react'
import { IconCopy, IconCheck, IconTerminal2, IconRefresh } from '@tabler/icons-react'
import { formatTimeLeft, installCommands, type Pairing } from './machines'

function CopyBlock({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="mt-2">
      <p className="mb-1 text-meta text-ink-muted">{label}</p>
      <div className="flex items-start gap-1.5">
        <code className="min-w-0 flex-1 break-all rounded-control border border-edge bg-page px-2 py-1.5 font-mono text-meta text-ink">
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
          aria-label={`Copy: ${label}`}
        >
          {copied ? <IconCheck size={14} stroke={2} className="text-success-4" /> : <IconCopy size={14} stroke={2} />}
        </button>
      </div>
    </div>
  )
}

/**
 * The current time, re-read on a cadence that suits a countdown to `until`:
 * every 15 s normally, every second in the final minute, never once past it.
 */
function useCountdownNow(until: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (until === null) return
    const current = Date.now()
    const left = until - current
    // A new deadline can arrive while `now` is old (the previous countdown
    // stopped at its expiry): catch up at once rather than show extra time.
    const stale = current - now > 1000
    if (left <= 0 && !stale) return
    // Land a tick exactly on the one-minute mark, then tick every second.
    const delay = stale ? 0 : Math.max(50, left > 60_000 ? Math.min(15_000, left - 60_000) : Math.min(1000, left))
    const timer = setTimeout(() => { setNow(Date.now()) }, delay)
    return () => { clearTimeout(timer) }
  }, [until, now])
  return now
}

interface InstallCommandProps {
  /** The command's token; null shows the button that generates one. */
  pairing: Pairing | null
  /** Generate (or regenerate) a command. */
  onGenerate: () => void
  generating: boolean
  /** Shown whatever else is on screen, including over an older command. */
  error: string | null
}

const primaryButton =
  'flex items-center gap-1.5 rounded-control bg-primary-8 px-3 py-1.5 text-body font-medium text-on-primary transition-colors hover:bg-primary-7 disabled:opacity-60'

export function InstallCommand({ pairing, onGenerate, generating, error }: InstallCommandProps) {
  const now = useCountdownNow(pairing?.expiresAt ?? null)
  const errorLine = error && <p role="alert" className="mt-1.5 text-meta text-error-4">{error}</p>

  if (!pairing) {
    return (
      <div className="mt-3">
        <button onClick={onGenerate} disabled={generating} className={primaryButton}>
          <IconTerminal2 size={15} stroke={2} />
          {generating ? 'Generating…' : 'Generate install command'}
        </button>
        {errorLine}
      </div>
    )
  }

  const left = pairing.expiresAt - now
  if (left <= 0) {
    return (
      <div className="mt-3">
        <p className="text-body text-ink">This install command expired before it was used.</p>
        <p className="mt-0.5 text-meta text-ink-muted">
          Commands work once and only for 10 minutes. Generate a new one and run it on your computer.
        </p>
        <button onClick={onGenerate} disabled={generating} className={`mt-2 ${primaryButton}`}>
          <IconRefresh size={15} stroke={2} />
          {generating ? 'Generating…' : 'Generate a new command'}
        </button>
        {errorLine}
      </div>
    )
  }

  const commands = installCommands(pairing.pairingToken, window.location.origin)
  return (
    <div className="mt-3">
      <CopyBlock
        label="Run this in a terminal on your computer. It installs Codekin and connects it to this account:"
        command={commands.install}
      />
      <CopyBlock
        label="Already running Codekin there? Connect it directly:"
        command={commands.login}
      />
      <p className="mt-2 text-meta text-ink-faint">
        Works once · expires in <span data-testid="time-left">{formatTimeLeft(left)}</span> ·{' '}
        <button
          onClick={onGenerate}
          disabled={generating}
          className="text-ink-muted underline underline-offset-2 hover:text-ink disabled:opacity-60"
        >
          {generating ? 'generating…' : 'regenerate'}
        </button>
      </p>
      {errorLine}
    </div>
  )
}
