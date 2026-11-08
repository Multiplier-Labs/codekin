/**
 * GitHub webhook receiver for the machine you are connected to: GitHub posts
 * to the relay, the relay forwards to this machine, and the machine's own
 * Codekin checks GitHub's signature (docs/SELF-HOSTED-RELAY.md, "GitHub webhooks").
 *
 * Owner-only. The URL is shown once, right after it is created: the relay
 * keeps only a hash of it.
 */

import { useEffect, useState } from 'react'
import { Row, button, dangerButton, quietButton } from '../components/settings/Block'
import { CopyBlock } from './InstallCommand'
import {
  disableMachineWebhook,
  enableMachineWebhook,
  fetchMachineWebhook,
  type Machine,
  type MachineWebhook as WebhookState,
} from './machines'

function when(iso: string | null): string {
  if (!iso) return 'never'
  // SQLite datetime('now') is UTC without a zone marker.
  const date = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

export function MachineWebhook({ machine }: { machine: Machine }) {
  const [state, setState] = useState<WebhookState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmOff, setConfirmOff] = useState(false)

  useEffect(() => {
    let live = true
    fetchMachineWebhook(machine.id)
      .then(s => { if (live) setState(s) })
      .catch(() => { if (live) setError('Could not load the webhook setting.') })
    return () => { live = false }
  }, [machine.id])

  const run = (action: () => Promise<WebhookState>, failure: string) => {
    setBusy(true)
    setError(null)
    action()
      .then(s => { setState(s); setConfirmOff(false) })
      .catch(() => { setError(failure) })
      .finally(() => { setBusy(false) })
  }

  const turnOn = () => { run(() => enableMachineWebhook(machine.id), 'Could not create the webhook URL. Try again.') }
  const turnOff = () => { run(() => disableMachineWebhook(machine.id), 'Could not turn the webhook off. Try again.') }

  const enabled = state?.enabled ?? false
  const description = !state
    ? 'Lets GitHub send CI events to this computer through the relay, for automatic CI fixes.'
    : enabled
      ? `On since ${when(state.createdAt)}. Last delivery: ${when(state.lastDeliveryAt)}.`
      : `Lets GitHub send CI events to ${machine.displayName} through the relay, for automatic CI fixes.`

  return (
    <Row
      label="GitHub webhook"
      description={description}
      control={state && (enabled ? (
        <>
          <button onClick={turnOn} disabled={busy} className={button} title="The current URL stops working">
            New URL
          </button>
          <button onClick={() => { setConfirmOff(c => !c) }} disabled={busy} className={quietButton} aria-expanded={confirmOff}>
            Turn off
          </button>
        </>
      ) : (
        <button onClick={turnOn} disabled={busy} className={button}>
          {busy ? 'Creating…' : 'Turn on'}
        </button>
      ))}
    >
      {error && <p role="alert" className="mt-2 text-meta text-error-4">{error}</p>}

      {state?.url && (
        <div className="mt-2 rounded-control border border-edge bg-surface px-3 py-2.5">
          <CopyBlock label="Payload URL (shown once; copy it now)" command={state.url} />
          <p className="mt-2 text-meta text-ink-muted">
            In GitHub, open the repository or organization settings, then Webhooks, then Add webhook. Paste this as the
            payload URL, set the content type to <span className="font-mono">application/json</span>, and use the
            webhook secret this computer&apos;s Codekin is configured with (<span className="font-mono">GITHUB_WEBHOOK_SECRET</span>).
            Choose the <span className="font-medium">Workflow runs</span> event. Deliveries are checked against that secret
            on this computer; the relay can&apos;t read or change them.
          </p>
        </div>
      )}

      {confirmOff && (
        <div className="mt-2 rounded-control border border-error-7/60 bg-page px-3 py-2.5" role="group" aria-label="Confirm turning off">
          <p className="text-body text-ink">
            Turn off the webhook? GitHub deliveries to its URL will fail until you turn it on again, which creates a new URL.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button onClick={turnOff} disabled={busy} className={dangerButton}>{busy ? 'Turning off…' : 'Turn off'}</button>
            <button onClick={() => { setConfirmOff(false) }} disabled={busy} className={quietButton}>Keep it</button>
          </div>
        </div>
      )}
    </Row>
  )
}
