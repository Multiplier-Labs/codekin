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
  approveRelayDevice, getRelayDevices, rejectRelayEnrolment, revokeRelayDevice, setRelayDevicePolicy, setRelayLocalConfirmationOnly,
  type RelayDevices, type RelayDevice,
} from '../../lib/ccApi'
import { Block, Row, Rows, checkbox, input } from './Block'
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

const POLICY_DESCRIPTION: Record<'off' | 'warn' | 'required', string> = {
  required: 'Requests through the relay must be signed by a device confirmed here. Only this computer can lower this.',
  warn: 'Unsigned requests through the relay still run, and are logged. The relay can control this computer.',
  off: "Signatures aren't checked. The relay can control this computer.",
}


/**
 * Codes are shown upper-case as they're typed. A pasted trust command or
 * token is kept exactly: it is case-sensitive base64url.
 */
function asTyped(value: string): string {
  return value.length <= 9 && /^[A-Za-z0-9\s-]*$/.test(value) ? value.toUpperCase() : value
}

export function RelayDevicesBlock({ token, onError }: Props) {
  const [data, setData] = useState<RelayDevices | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [code, setCode] = useState('')
  const [codeError, setCodeError] = useState<string | null>(null)
  const [added, setAdded] = useState<{ label: string; confirmCode: string | null; policyRaised?: boolean } | null>(null)
  const [tokenWaiting, setTokenWaiting] = useState(false)

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
    setTokenWaiting(false)
    try {
      const device = await approveRelayDevice(token, code.trim())
      setCode('')
      if (device.waiting) setTokenWaiting(true)
      else setAdded({ label: device.label, confirmCode: device.confirmCode, policyRaised: device.policyRaised === true })
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

  const changePolicy = async (policy: 'off' | 'warn' | 'required') => {
    if (policy !== 'required' && !window.confirm('Let the relay control this computer without a confirmed device? Anyone who can act as you on the relay, or the relay itself, could then run commands here.')) return
    try {
      await setRelayDevicePolicy(token, policy)
      await refresh()
    } catch (err) {
      onError(err instanceof Error ? err.message : "Couldn't change the setting")
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
  const policy = data.devices?.policy ?? 'off'
  return (
    <>
    <Block
      title="Devices that can control this computer"
      description={policy === 'required'
        ? 'Browsers you confirmed on this computer. Only they can control it through the relay; the relay alone cannot.'
        : 'Browsers you confirmed on this computer. The relay can still control it without one: confirm a browser to stop that.'}
    >
      <Rows>
        {data.devices && (
          <Row
            label="Control through the relay"
            htmlFor="relay-device-policy"
            description={POLICY_DESCRIPTION[policy]}
            control={
              <select
                id="relay-device-policy"
                value={policy}
                onChange={e => { void changePolicy(e.target.value as 'off' | 'warn' | 'required') }}
                className="rounded-control border border-edge bg-page px-2 py-1.5 text-body text-ink focus:border-focus focus:outline-none"
              >
                <option value="required">Confirmed devices only</option>
                <option value="warn">Anyone, with a warning</option>
                <option value="off">Anyone the relay lets in</option>
              </select>
            }
          />
        )}
        <Row
          label="Confirm a browser"
          htmlFor="relay-device-code"
          description={pending.length > 0
            ? `${pending.length === 1 ? 'A browser is' : `${pending.length} browsers are`} waiting. Paste the command it shows, or type its code.`
            : 'In the browser, choose "Confirm this browser" for this computer, then paste the command it shows here (or type its code).'}
          control={
            <form
              className="flex gap-2"
              onSubmit={e => { e.preventDefault(); void approve() }}
            >
              <input
                id="relay-device-code"
                value={code}
                onChange={e => { setCode(asTyped(e.target.value)); setCodeError(null) }}
                placeholder="Command or XXXX-XXXX"
                autoComplete="off"
                spellCheck={false}
                maxLength={200}
                className={`${input} w-56 font-mono`}
              />
              <button type="submit" disabled={busy || code.trim().length < 8} className={primaryButton}>Confirm</button>
            </form>
          }
        >
          {codeError && <p className="mt-2 text-meta text-warning-5">{codeError}</p>}
          {tokenWaiting && (
            <p className="mt-2 text-meta text-ink-muted">Ready. The browser that showed this command is confirmed as soon as it asks (within 30 minutes).</p>
          )}
          {added && (
            <div className="mt-3 rounded-control border border-edge bg-surface-raised px-3 py-2">
              <p className="flex items-center gap-1.5 text-meta text-success-5">
                <IconCircleCheckFilled size={14} /> {added.label} can now control this computer.
              </p>
              {added.confirmCode ? (
                <>
                  <p className="mt-1 text-meta text-ink-muted">To finish, type this code in that browser:</p>
                  <p className="mt-1 font-mono text-title tracking-widest text-ink" aria-label="Code for the browser">{added.confirmCode}</p>
                </>
              ) : (
                <p className="mt-1 text-meta text-ink-muted">That browser finishes by itself.</p>
              )}
              {added.policyRaised && (
                <p className="mt-2 text-meta text-ink-muted">
                  It was your first device here, so this computer now takes control through the relay only from confirmed devices. Your other browsers need confirming too, and existing shares need Allow again in the share dialog. You can change this below.
                </p>
              )}
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
        {data.devices && devices.some(d => d.kind === 'passkey') && (
          <Row
            label="Let my passkey add browsers"
            htmlFor="relay-passkey-adds"
            description="A browser can then be added with Face ID, Touch ID or your security key, without typing a code here. Turn it off if you don't trust your passkey provider's sync."
            control={
              <input
                id="relay-passkey-adds"
                type="checkbox"
                className={checkbox}
                checked={!data.devices.localConfirmationOnly}
                onChange={e => {
                  const allow = e.target.checked
                  setRelayLocalConfirmationOnly(token, !allow).then(refresh).catch(() => { onError("Couldn't change the setting") })
                }}
              />
            }
          />
        )}
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
