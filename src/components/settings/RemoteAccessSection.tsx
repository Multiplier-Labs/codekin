/**
 * Remote access (machine setting, local only): pair this machine with a
 * hosted relay (app.codekin.ai, or a self-hosted one) so a phone or another
 * computer can reach it, without `codekin relay login` in a terminal
 * (desktop plan D2). Shows the connector's state once paired, and unpairs.
 *
 * No window.confirm: WKWebView in the desktop app may not implement it (D6),
 * so destructive actions confirm inline.
 */

import { useCallback, useEffect, useState } from 'react'
import { IconCircleCheckFilled, IconAlertTriangle, IconExternalLink, IconLoader2 } from '@tabler/icons-react'
import {
  getRelayStatus, getRelayPairing, startRelayPairing, cancelRelayPairing, unpairRelay,
  type RelayStatus, type RelayPairingState,
} from '../../lib/ccApi'
import { Block, Row, Rows, input } from './Block'

const DEFAULT_RELAY = 'https://app.codekin.ai'
const POLL_MS = 2000

const CONNECTOR_STATE: Record<RelayStatus['state'], { label: string; tone: 'ok' | 'busy' | 'warn' }> = {
  connected: { label: 'Online', tone: 'ok' },
  update_required: { label: 'The relay requires a newer Codekin. Run `codekin upgrade`.', tone: 'warn' },
  connecting: { label: 'Connecting…', tone: 'busy' },
  disconnected: { label: 'Reconnecting…', tone: 'busy' },
  secret_unavailable: { label: 'Cannot access the saved credential. Retrying automatically…', tone: 'warn' },
  unpaired: { label: 'Not paired', tone: 'warn' },
  unmanaged: { label: 'Run by `codekin relay connect`, not by this server', tone: 'warn' },
  replaced: { label: 'Another connector took over this machine', tone: 'warn' },
  auth_failed: { label: 'The relay rejected this machine. Unpair and pair again.', tone: 'warn' },
  disabled: { label: 'Disabled (CODEKIN_RELAY_CONNECTOR=off)', tone: 'warn' },
  stopped: { label: 'Stopped', tone: 'warn' },
}

const primaryButton = 'rounded-control bg-primary-8 px-3 py-1.5 text-body font-medium text-on-primary hover:bg-primary-7 disabled:opacity-50 transition-colors'
const plainButton = 'rounded-control border border-edge px-3 py-1.5 text-body text-ink hover:bg-surface-raised disabled:opacity-50 transition-colors'

interface Props {
  token: string
  onError: (message: string) => void
}

export function RemoteAccessSection({ token, onError }: Props) {
  const [status, setStatus] = useState<RelayStatus | null>(null)
  const [pairing, setPairing] = useState<RelayPairingState>({ state: 'idle' })
  const [busy, setBusy] = useState(false)
  const [customRelay, setCustomRelay] = useState(false)
  const [relayUrl, setRelayUrl] = useState('')
  const [confirmUnpair, setConfirmUnpair] = useState(false)

  const refresh = useCallback(async () => {
    const [s, p] = await Promise.all([getRelayStatus(token), getRelayPairing(token)])
    setStatus(s)
    setPairing(p)
  }, [token])

  useEffect(() => {
    if (!token) return
    refresh().catch(() => { onError("Couldn't read this machine's remote access state") })
  }, [token, refresh, onError])

  // Poll while something is in flight: an approval, or the connector coming online.
  const inFlight = pairing.state === 'pending' || status?.state === 'connecting' || status?.state === 'disconnected' || status?.state === 'secret_unavailable'
    || (pairing.state === 'complete' && status?.state !== 'connected')
  useEffect(() => {
    if (!token || !inFlight) return
    const t = setInterval(() => { refresh().catch(() => {}) }, POLL_MS)
    return () => { clearInterval(t) }
  }, [token, inFlight, refresh])

  const start = async () => {
    setBusy(true)
    try {
      setPairing(await startRelayPairing(token, customRelay && relayUrl.trim() ? relayUrl.trim() : undefined))
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Pairing failed to start')
    } finally {
      setBusy(false)
    }
  }

  const cancel = async () => {
    try { setPairing(await cancelRelayPairing(token)) } catch { onError("Couldn't cancel pairing") }
  }

  const unpair = async () => {
    setBusy(true)
    try {
      await unpairRelay(token)
      setConfirmUnpair(false)
      await refresh()
    } catch {
      onError("Couldn't unpair this machine")
    } finally {
      setBusy(false)
    }
  }

  if (!status) return null

  // --- Paired -------------------------------------------------------------
  if (status.paired) {
    const s = CONNECTOR_STATE[status.state]
    return (
      <div className="space-y-4">
        <Block title="Hosted relay" description="This machine is paired with a hosted relay. Open it there from your phone or another computer.">
          <Rows>
            <Row
              label="Relay"
              description={status.machineId ? `Machine ${status.machineId}` : undefined}
              control={status.relayUrl ? (
                <a href={status.relayUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-body text-primary-5 hover:underline">
                  {status.relayUrl.replace(/^https?:\/\//, '')} <IconExternalLink size={14} />
                </a>
              ) : null}
            />
            <Row
              label="Connection"
              control={
                <span className={`flex items-center gap-1.5 text-body ${s.tone === 'ok' ? 'text-success-5' : s.tone === 'busy' ? 'text-ink-muted' : 'text-warning-5'}`}>
                  {s.tone === 'ok' && <IconCircleCheckFilled size={16} />}
                  {s.tone === 'busy' && <IconLoader2 size={16} className="animate-spin" />}
                  {s.tone === 'warn' && <IconAlertTriangle size={16} />}
                  {s.label}
                </span>
              }
            />
            <Row
              label="Unpair"
              description="Removes this machine's credential here. To revoke it on the relay too, remove it under Settings → Machines there."
              control={confirmUnpair ? (
                <div className="flex gap-2">
                  <button type="button" disabled={busy} onClick={() => { void unpair() }} className="rounded-control bg-error-8 px-3 py-1.5 text-body font-medium text-on-primary hover:bg-error-7 disabled:opacity-50">
                    Unpair this machine
                  </button>
                  <button type="button" onClick={() => { setConfirmUnpair(false) }} className={plainButton}>Keep</button>
                </div>
              ) : (
                <button type="button" onClick={() => { setConfirmUnpair(true) }} className={plainButton}>Unpair…</button>
              )}
            />
          </Rows>
        </Block>
      </div>
    )
  }

  // --- Waiting for approval ---------------------------------------------
  if (pairing.state === 'pending') {
    return (
      <div className="space-y-4">
        <Block title="Approve this machine" description="Sign in on the relay and confirm the code below. This page updates by itself once you approve.">
          <div className="flex flex-col items-start gap-4">
            <p className="font-mono text-head tracking-widest text-ink" aria-label="Pairing code">{pairing.userCode}</p>
            <div className="flex flex-wrap items-center gap-2">
              <a href={pairing.verificationUrl} target="_blank" rel="noopener noreferrer" className={`${primaryButton} flex items-center gap-1.5`}>
                Open {new URL(pairing.verificationUrl).host} <IconExternalLink size={14} />
              </a>
              <button type="button" onClick={() => { void cancel() }} className={plainButton}>Cancel</button>
            </div>
            <p className="flex items-center gap-1.5 text-meta text-ink-muted">
              <IconLoader2 size={14} className="animate-spin" /> Waiting for approval…
            </p>
            <p className="break-all text-meta text-ink-faint">{pairing.verificationUrl}</p>
          </div>
        </Block>
      </div>
    )
  }

  // --- Not paired ---------------------------------------------------------
  const outcome = pairing.state === 'denied' ? 'Pairing was denied on the relay.'
    : pairing.state === 'expired' ? 'The pairing code expired before it was approved.'
      : pairing.state === 'failed' ? (pairing.detail ?? 'Pairing failed.')
        : pairing.state === 'complete' ? 'Paired. Bringing this machine online…'
          : null

  return (
    <div className="space-y-4">
      <Block
        title="Hosted relay"
        description="Reach this machine's sessions from your phone or another computer through a hosted relay. Codekin keeps running here; the relay only forwards traffic."
      >
        <Rows>
          <Row
            label={`Pair with ${customRelay && relayUrl.trim() ? relayUrl.trim().replace(/^https?:\/\//, '') : 'app.codekin.ai'}`}
            description="You'll confirm a short code on the relay, signed in with your account."
            control={
              <button type="button" disabled={busy} onClick={() => { void start() }} className={primaryButton}>
                {busy ? 'Starting…' : pairing.state === 'idle' ? 'Pair this machine' : 'Try again'}
              </button>
            }
          >
            {outcome && (
              <p className={`mt-2 text-meta ${pairing.state === 'complete' ? 'text-success-5' : 'text-warning-5'}`}>{outcome}</p>
            )}
          </Row>
          <Row
            label="Self-hosted relay"
            htmlFor="settings-relay-url"
            description={<>Running your own relay? See <a href="https://github.com/Multiplier-Labs/codekin/blob/main/docs/SELF-HOSTED-RELAY.md" target="_blank" rel="noopener noreferrer" className="text-primary-5 hover:underline">the self-hosting guide</a>.</>}
            control={customRelay ? (
              <input
                id="settings-relay-url"
                type="url"
                placeholder={DEFAULT_RELAY}
                value={relayUrl}
                onChange={e => { setRelayUrl(e.target.value) }}
                className={`${input} w-72`}
              />
            ) : (
              <button type="button" onClick={() => { setCustomRelay(true) }} className={plainButton}>Use another relay…</button>
            )}
          />
        </Rows>
      </Block>
    </div>
  )
}
