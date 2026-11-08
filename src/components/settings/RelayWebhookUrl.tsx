/**
 * Webhook URL for a machine reached through a relay (hosted mode). GitHub
 * posts to the relay's receiver for this machine, the relay forwards to it,
 * and the machine checks GitHub's signature itself
 * (docs/SELF-HOSTED-RELAY.md, "GitHub webhooks").
 *
 * Owner-only on the relay: anyone else gets a 403 and sees that instead.
 */

import { useCallback, useEffect, useState } from 'react'
import { IconCheck, IconCopy } from '@tabler/icons-react'
import {
  disableRelayWebhook, enableRelayWebhook, fetchRelayWebhook, RelayWebhookError, type RelayWebhook,
} from '../../lib/relayWebhook'
import { button, dangerButton, quietButton } from './Block'

function when(iso: string | null): string {
  if (!iso) return 'never'
  // SQLite datetime('now') is UTC without a zone marker.
  const date = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

function CopyUrl({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-center gap-1 rounded-control border border-edge bg-page px-3 py-2">
      <code className="flex-1 truncate select-all font-mono text-body text-ink">{url}</code>
      <button
        onClick={() => {
          void navigator.clipboard.writeText(url).then(() => {
            setCopied(true)
            setTimeout(() => { setCopied(false) }, 2000)
          })
        }}
        className="rounded-control p-1.5 text-ink-muted transition-colors hover:bg-surface-raised hover:text-ink"
        title="Copy to clipboard"
        aria-label="Copy webhook URL"
      >
        {copied ? <IconCheck size={14} className="text-success-6" /> : <IconCopy size={14} />}
      </button>
    </div>
  )
}

type Confirm = 'rotate' | 'off' | null

export function RelayWebhookUrl({ machineId, onUrl }: {
  machineId: string
  /** The URL GitHub should use, or null while there is none. */
  onUrl: (url: string | null) => void
}) {
  const [state, setState] = useState<RelayWebhook | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Confirm>(null)

  const apply = useCallback((next: RelayWebhook) => {
    setState(next)
    onUrl(next.url)
  }, [onUrl])

  useEffect(() => {
    let live = true
    fetchRelayWebhook(machineId)
      .then(s => { if (live) apply(s) })
      .catch((err: unknown) => {
        if (!live) return
        if (err instanceof RelayWebhookError && err.status === 403) setForbidden(true)
        else setError('Could not load this machine’s webhook URL.')
      })
    return () => { live = false }
  }, [machineId, apply])

  const run = (action: () => Promise<RelayWebhook>, failure: string) => {
    setBusy(true)
    setError(null)
    action()
      .then(s => { apply(s); setConfirm(null) })
      .catch(() => { setError(failure) })
      .finally(() => { setBusy(false) })
  }
  const turnOn = () => { run(() => enableRelayWebhook(machineId), 'Could not create the webhook URL. Try again.') }
  const turnOff = () => { run(() => disableRelayWebhook(machineId), 'Could not turn the webhook URL off. Try again.') }

  if (forbidden) {
    return <p className="text-body text-ink-muted">Only this machine’s owner can see and manage its webhook URL.</p>
  }

  return (
    <div>
      <label className="mb-1.5 block text-body font-medium text-ink">Webhook URL</label>
      {!state && !error && <p className="text-body text-ink-muted">Loading…</p>}

      {state && !state.enabled && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-body text-ink-muted">
            This machine is reached through the relay, so GitHub sends webhooks to the relay, which forwards them here.
            Turn on a URL for this machine to receive them.
          </p>
          <button onClick={turnOn} disabled={busy} className={button}>{busy ? 'Creating…' : 'Turn on'}</button>
        </div>
      )}

      {state?.enabled && (
        <>
          {state.url
            ? <CopyUrl url={state.url} />
            : <p className="text-body text-ink-muted">This URL was created before it could be shown again. Choose New URL to see one (the old URL then stops working).</p>}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            <p className="min-w-0 flex-1 text-meta text-ink-muted">
              Paste this as the Payload URL in GitHub. It goes through the relay, which can’t forge or change deliveries:
              this machine checks GitHub’s signature. Last delivery: {when(state.lastDeliveryAt)}.
            </p>
            <button onClick={() => { setConfirm(c => c === 'rotate' ? null : 'rotate') }} disabled={busy} className={quietButton} aria-expanded={confirm === 'rotate'}>
              New URL
            </button>
            <button onClick={() => { setConfirm(c => c === 'off' ? null : 'off') }} disabled={busy} className={quietButton} aria-expanded={confirm === 'off'}>
              Turn off
            </button>
          </div>
        </>
      )}

      {confirm && (
        <div className="mt-2 rounded-control border border-error-7/60 bg-page px-3 py-2.5" role="group" aria-label={confirm === 'rotate' ? 'Confirm new URL' : 'Confirm turning off'}>
          <p className="text-body text-ink">
            {confirm === 'rotate'
              ? 'Replace the URL? The current one stops working at once, so update every GitHub webhook that uses it.'
              : 'Turn off the webhook URL? GitHub deliveries to it will fail until you turn it on again, which creates a new URL.'}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button onClick={confirm === 'rotate' ? turnOn : turnOff} disabled={busy} className={dangerButton}>
              {confirm === 'rotate' ? 'Replace URL' : 'Turn off'}
            </button>
            <button onClick={() => { setConfirm(null) }} disabled={busy} className={quietButton}>Keep it</button>
          </div>
        </div>
      )}

      {error && <p role="alert" className="mt-2 text-meta text-error-4">{error}</p>}
    </div>
  )
}
