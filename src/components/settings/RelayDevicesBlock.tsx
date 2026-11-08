/**
 * Settings → Remote access → "Devices that can control this computer"
 * (docs/RELAY-SIGNED-INTENTS-AND-E2E-SPEC.md §5.5). The machine's own list of
 * browsers allowed to act on it through the relay, read from
 * relay-devices.json by the local server. Local only: the relay can't reach
 * /api/relay/*.
 *
 * A browser asks to be confirmed from the hosted app, which shows an
 * 8-character code. Typing that code here is what adds it: the list of
 * waiting requests deliberately never shows the code, because comparing two
 * codes on screen is what people click through without looking.
 *
 * Nothing is enforced yet; the list is kept for when it is.
 */

import { useCallback, useEffect, useState } from 'react'
import { IconCircleCheckFilled } from '@tabler/icons-react'
import {
  approveRelayDevice, getRelayDevices, rejectRelayEnrolment, revokeRelayDevice,
  type RelayDevices, type RelayDevice,
} from '../../lib/ccApi'
import { Block, Row, Rows, input } from './Block'
import { RelayActivityBlock } from './RelayActivityBlock'

const plainButton = 'rounded-control border border-edge px-3 py-1.5 text-body text-ink hover:bg-surface-raised disabled:opacity-50 transition-colors'
const primaryButton = 'rounded-control bg-primary-8 px-3 py-1.5 text-body font-medium text-on-primary hover:bg-primary-7 disabled:opacity-50 transition-colors'

/** Often enough that a code typed a few seconds after the browser shows it finds its request. */
const POLL_MS = 3000

function addedByText(addedBy: string): string {
  if (addedBy === 'local') return 'confirmed on this computer'
  if (addedBy.startsWith('passkey:')) return 'added by passkey'
  return addedBy
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

interface Props {
  token: string
  onError: (message: string) => void
}

export function RelayDevicesBlock({ token, onError }: Props) {
  const [data, setData] = useState<RelayDevices | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [code, setCode] = useState('')
  const [codeError, setCodeError] = useState<string | null>(null)
  const [added, setAdded] = useState<{ label: string; confirmCode: string } | null>(null)

  const refresh = useCallback(async () => {
    setData(await getRelayDevices(token))
  }, [token])

  useEffect(() => {
    if (!token) return
    refresh().catch(() => { onError("Couldn't read this computer's device list") })
    // Requests arrive from the browser at any time; keep the list current.
    const t = setInterval(() => { refresh().catch(() => {}) }, POLL_MS)
    return () => { clearInterval(t) }
  }, [token, refresh, onError])

  const approve = async () => {
    setBusy(true)
    setCodeError(null)
    setAdded(null)
    try {
      const device = await approveRelayDevice(token, code.trim())
      setCode('')
      setAdded({ label: device.label, confirmCode: device.confirmCode })
      await refresh()
    } catch (err) {
      setCodeError(err instanceof Error ? err.message : "Couldn't confirm the browser")
    } finally {
      setBusy(false)
    }
  }

  const reject = async (enrolId: string) => {
    try {
      await rejectRelayEnrolment(token, enrolId)
      await refresh()
    } catch (err) {
      onError(err instanceof Error ? err.message : "Couldn't turn the request down")
    }
  }

  const remove = async (device: RelayDevice) => {
    setBusy(true)
    try {
      await revokeRelayDevice(token, device.keyId)
      setConfirming(null)
      await refresh()
    } catch (err) {
      onError(err instanceof Error ? err.message : "Couldn't remove the device")
    } finally {
      setBusy(false)
    }
  }

  if (!data?.paired) return null

  const devices = data.devices?.credentials ?? []
  const pending = data.devices?.pending ?? []
  const approved = data.devices?.approved ?? []
  return (
    <>
    <Block
      title="Devices that can control this computer"
      description="Browsers you confirmed on this computer. Codekin doesn't check them yet: for now the relay is still trusted to say who is in control."
    >
      <Rows>
        <Row
          label="Confirm a browser"
          htmlFor="relay-device-code"
          description={pending.length > 0
            ? `${pending.length === 1 ? 'A browser is' : `${pending.length} browsers are`} waiting. Type the code shown in the browser you want to allow.`
            : 'In the browser, choose "Confirm this browser" for this computer, then type the code it shows here.'}
          control={
            <form
              className="flex gap-2"
              onSubmit={e => { e.preventDefault(); void approve() }}
            >
              <input
                id="relay-device-code"
                value={code}
                onChange={e => { setCode(e.target.value.toUpperCase()); setCodeError(null) }}
                placeholder="XXXX-XXXX"
                autoComplete="off"
                spellCheck={false}
                maxLength={12}
                className={`${input} w-32 font-mono tracking-widest`}
              />
              <button type="submit" disabled={busy || code.trim().length < 8} className={primaryButton}>Confirm</button>
            </form>
          }
        >
          {codeError && <p className="mt-2 text-meta text-warning-5">{codeError}</p>}
          {added && (
            <div className="mt-3 rounded-control border border-edge bg-surface-raised px-3 py-2">
              <p className="flex items-center gap-1.5 text-meta text-success-5">
                <IconCircleCheckFilled size={14} /> {added.label} can now control this computer.
              </p>
              <p className="mt-1 text-meta text-ink-muted">To finish, type this code in that browser:</p>
              <p className="mt-1 font-mono text-title tracking-widest text-ink" aria-label="Code for the browser">{added.confirmCode}</p>
            </div>
          )}
        </Row>
        {approved.filter(a => a.confirmCode !== added?.confirmCode).map(a => (
          <Row
            key={a.enrolId}
            label={`Finish in ${a.label}`}
            description="Confirmed here. Type this code in that browser to finish."
            control={<span className="font-mono text-body tracking-widest text-ink">{a.confirmCode}</span>}
          />
        ))}
        {pending.map(p => (
          <Row
            key={p.enrolId}
            label={`Waiting: ${p.label}`}
            description={`Asked at ${formatTime(p.createdAt)}. Expires at ${formatTime(p.expiresAt)}.`}
            control={<button type="button" onClick={() => { void reject(p.enrolId) }} className={plainButton}>Turn down</button>}
          />
        ))}
        <Row
          label="This computer's identity key"
          description="Browsers check this key when you confirm them."
          control={<span className="font-mono text-meta text-ink-muted">{data.identity?.keyId ?? 'Created when the connector starts'}</span>}
        />
        {data.error && (
          <Row label="Device list unreadable" description={data.error} />
        )}
        {!data.error && devices.length === 0 && (
          <Row label="No devices yet" />
        )}
        {devices.map(device => (
          <Row
            key={device.keyId}
            label={device.label || device.keyId}
            description={`${device.kind === 'passkey' ? 'Passkey' : 'Browser'} · ${addedByText(device.addedBy)} · ${formatDate(device.addedAt)}${device.lastUsedAt ? ` · last used ${formatDate(device.lastUsedAt)}` : ''}`}
            control={confirming === device.keyId ? (
              <div className="flex gap-2">
                <button type="button" disabled={busy} onClick={() => { void remove(device) }} className="rounded-control bg-error-8 px-3 py-1.5 text-body font-medium text-on-primary hover:bg-error-7 disabled:opacity-50">
                  Remove
                </button>
                <button type="button" onClick={() => { setConfirming(null) }} className={plainButton}>Keep</button>
              </div>
            ) : (
              <button type="button" onClick={() => { setConfirming(device.keyId) }} className={plainButton}>Remove…</button>
            )}
          />
        ))}
      </Rows>
    </Block>
    <RelayActivityBlock token={token} deviceLabels={Object.fromEntries(devices.map(d => [d.keyId, d.label]))} />
    </>
  )
}
