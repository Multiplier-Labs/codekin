/**
 * "Confirm this browser on <machine>" (docs/RELAY-SIGNED-INTENTS-AND-E2E-SPEC.md
 * §5.2, §6.9): runs the enrolment ceremony over the relay and shows the
 * 8-character code the owner types on the machine.
 *
 * Opened from the machine list and straight after approving a pairing, when
 * the person is at the machine anyway (§5.3). Nothing is enforced yet, so
 * this is an offer, not a gate.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { IconCircleCheckFilled, IconLoader2, IconAlertTriangle } from '@tabler/icons-react'
import { RelayConnection, RelayRequestError } from '../lib/transport/relay-client'
import {
  EnrolmentFailure, certifyWithPasskey, currentUserId, deviceTrustSupported, startEnrolment, trustStorage, type Enrolment, type PasskeyKey,
} from './deviceTrust'
import { assertWithPasskey, fetchPasskeyKeys, isPasskeyCancel, passkeysSupported } from './passkeys'
import { button, checkbox, quietButton } from '../components/settings/Block'
import { CopyBlock } from './InstallCommand'

const POLL_MS = 2000
/** The machine drops an undecided request after 10 minutes. */
const REQUEST_TTL_MS = 10 * 60_000 + 30_000
/** How long to keep retrying while the machine comes online (just paired). */
const ONLINE_WAIT_MS = 90_000

type Phase =
  /** The account has passkeys: use one, or show a code. */
  | { kind: 'choose' }
  | { kind: 'starting'; waitingForMachine: boolean }
  /** `accepted`: the machine reported (signed) that the code was typed; the finishing code is next. */
  | { kind: 'code'; enrolment: Enrolment; accepted: boolean }
  | { kind: 'done'; outcome: 'approved' | 'rejected' | 'expired' }
  | { kind: 'failed'; message: string; keyChanged?: boolean; offerCode?: boolean }

interface TrustSheetProps {
  machineId: string
  machineName: string
  onClose: () => void
  /** Called once the machine confirmed this browser. */
  onTrusted?: () => void
  /** Go straight to the code (the person is at the computer, e.g. just paired it). */
  preferCode?: boolean
}

function describeError(err: unknown): string {
  if (err instanceof EnrolmentFailure) return err.message
  if (err instanceof RelayRequestError) {
    if (err.code === 'connector_update_required') return 'Update Codekin on that computer to confirm browsers on it.'
    return err.message
  }
  return err instanceof Error ? err.message : 'Something went wrong'
}

/**
 * A passkey the computer has never seen. It is only added there while a
 * browser is confirmed with a code, so the first confirmation on a computer
 * is always a code. Older computers send the bare reason code.
 */
const passkeyUnknown = (err: unknown) => err instanceof Error && err.message.includes('intent_unknown_key')

/** Codes compare without case, spaces or dashes. */
const normaliseCode = (code: string) => code.replace(/[\s-]/g, '').toUpperCase()

const retryable = (err: unknown) => err instanceof RelayRequestError && ['machine_offline', 'timeout', 'disconnected'].includes(err.code)

export function TrustSheet({ machineId, machineName, onClose, onTrusted, preferCode }: TrustSheetProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'starting', waitingForMachine: false })
  const [attempt, setAttempt] = useState(0)
  /** How to confirm: a code typed on the computer, or an enrolled passkey (device_certify). Null until known. */
  const [method, setMethod] = useState<'code' | 'passkey' | null>(null)
  const [passkeys, setPasskeys] = useState<PasskeyKey[]>([])
  const [addPasskey, setAddPasskey] = useState(true)
  const connection = useRef<RelayConnection | null>(null)

  // The account's passkeys decide whether there is a choice to make.
  useEffect(() => {
    const life = { stopped: false }
    const keys = passkeysSupported() ? fetchPasskeyKeys() : Promise.resolve([])
    void keys.then(found => {
      if (life.stopped) return
      setPasskeys(found)
      if (found.length > 0 && !preferCode) setPhase({ kind: 'choose' })
      else setMethod('code')
    })
    return () => { life.stopped = true }
  }, [preferCode])

  useEffect(() => {
    if (method === null) return
    if (!deviceTrustSupported()) {
      setPhase({ kind: 'failed', message: "This browser can't keep a signing key (private browsing, or storage turned off)." })
      return
    }
    // An object, not a let: the async loop reads it after awaits.
    const life = { cancelled: false }
    const stopped = () => life.cancelled
    const conn = new RelayConnection({ machineId })
    connection.current = conn
    conn.connect()
    const deadline = Date.now() + ONLINE_WAIT_MS

    void (async () => {
      const userId = await currentUserId()
      if (!userId) {
        if (!stopped()) setPhase({ kind: 'failed', message: 'Sign in again, then try once more.' })
        return
      }
      const send = (kind: Parameters<RelayConnection['enrol']>[0], payload: unknown) => conn.enrol(kind, payload)
      for (;;) {
        try {
          if (method === 'passkey') {
            await certifyWithPasskey(send, { userId, machineId, candidates: passkeys, assert: assertWithPasskey })
            if (!stopped()) {
              setPhase({ kind: 'done', outcome: 'approved' })
              onTrusted?.()
            }
            return
          }
          const enrolment = await startEnrolment(send, {
            userId, machineId,
            ...(addPasskey && passkeys.length > 0 ? { passkeys: { candidates: passkeys, assert: assertWithPasskey } } : {}),
          })
          if (!stopped()) setPhase({ kind: 'code', enrolment, accepted: false })
          return
        } catch (err) {
          if (stopped()) return
          if (retryable(err) && Date.now() < deadline) {
            setPhase({ kind: 'starting', waitingForMachine: true })
            await new Promise(r => setTimeout(r, 3000))
            if (stopped()) return
            continue
          }
          setPhase({
            kind: 'failed',
            message: method === 'passkey' && isPasskeyCancel(err) ? 'The passkey prompt was closed.'
              : method === 'passkey' && passkeyUnknown(err)
                ? `Your passkey isn't confirmed on ${machineName} yet. Confirm this browser with a code once, keeping "Also confirm my passkey" ticked. After that your passkey can add your other browsers.`
                : describeError(err),
            keyChanged: err instanceof EnrolmentFailure && err.code === 'machine_key_changed',
            offerCode: method === 'passkey',
          })
          return
        }
      }
    })()

    return () => {
      life.cancelled = true
      conn.close()
      connection.current = null
    }
    // Started once per choice; the passkey list and checkbox are read when it starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineId, attempt, method])

  // Ask the machine whether the code was typed, one question at a time
  // (a slow relay must not pile them up), until it decides or the request
  // expires.
  useEffect(() => {
    if (phase.kind !== 'code' || phase.accepted) return
    const life = { stopped: false }
    const giveUpAt = Date.now() + REQUEST_TTL_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    const ask = () => {
      if (Date.now() > giveUpAt) {
        setPhase({ kind: 'done', outcome: 'expired' })
        return
      }
      phase.enrolment.check()
        .then(outcome => {
          if (life.stopped) return
          if (!outcome) { timer = setTimeout(ask, POLL_MS); return }
          // An approval only moves the sheet on to the finishing code; it is
          // never proof on its own (a relay could forge it). Polling stops.
          if (outcome === 'approved') setPhase({ ...phase, accepted: true })
          else setPhase({ kind: 'done', outcome })
        })
        .catch((err: unknown) => {
          if (life.stopped) return
          if (retryable(err)) timer = setTimeout(ask, POLL_MS)
          else setPhase({ kind: 'failed', message: describeError(err) })
        })
    }
    timer = setTimeout(ask, POLL_MS)
    return () => { life.stopped = true; clearTimeout(timer) }
  }, [phase])

  const [typed, setTyped] = useState('')
  /** 'own': the browser's own code was typed back, before typing it on the computer. */
  const [typedWrong, setTypedWrong] = useState<false | 'own' | 'wrong'>(false)
  const finish = async () => {
    if (phase.kind !== 'code') return
    if (normaliseCode(typed) === normaliseCode(phase.enrolment.code)) {
      setTypedWrong('own')
      return
    }
    if (await phase.enrolment.confirm(typed)) {
      setPhase({ kind: 'done', outcome: 'approved' })
      onTrusted?.()
    } else {
      setTypedWrong('wrong')
    }
  }

  const forgetOldKey = useCallback(async () => {
    const userId = await currentUserId()
    if (userId) await trustStorage().deletePin(userId, machineId)
    setPhase({ kind: 'starting', waitingForMachine: false })
    setAttempt(a => a + 1)
  }, [machineId])

  const restart = () => {
    setTyped('')
    setTypedWrong(false)
    setPhase({ kind: 'starting', waitingForMachine: false })
    setAttempt(a => a + 1)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-page/80 p-4" role="dialog" aria-modal="true" aria-labelledby="trust-sheet-title">
      <div className="w-full max-w-md rounded-floating border border-edge-strong bg-surface-raised p-6 shadow-floating">
        <h2 id="trust-sheet-title" className="mb-2 text-title font-semibold text-ink">Confirm this browser on {machineName}</h2>

        {phase.kind === 'choose' && (
          <div className="space-y-3">
            <p className="text-body text-ink-muted">Let this browser control {machineName}:</p>
            <button type="button" onClick={() => { setPhase({ kind: 'starting', waitingForMachine: false }); setMethod('passkey') }} className={`${button} w-full`}>
              Use my passkey
            </button>
            <p className="text-meta text-ink-faint">Works if your passkey is already confirmed on {machineName}, and it allows that.</p>
            <button type="button" onClick={() => { setPhase({ kind: 'starting', waitingForMachine: false }); setMethod('code') }} className={`${button} w-full`}>
              Show a code to type on {machineName}
            </button>
            <label className="flex items-center gap-2 text-meta text-ink-muted">
              <input type="checkbox" className={checkbox} checked={addPasskey} onChange={e => { setAddPasskey(e.target.checked) }} />
              Also confirm my passkey there, so it can add browsers and approve sensitive actions
            </label>
          </div>
        )}

        {phase.kind === 'starting' && (
          <p className="flex items-center gap-2 text-body text-ink-muted">
            <IconLoader2 size={16} className="animate-spin" />
            {phase.waitingForMachine ? `Waiting for ${machineName} to come online…` : 'Preparing a code…'}
          </p>
        )}

        {phase.kind === 'code' && (
          <div className="space-y-4">
            <p className="text-body text-ink-muted"><span className="font-semibold text-ink">1.</span> Approve this code on {machineName} itself, not here:</p>
            <p className="text-center font-mono text-head tracking-widest text-ink" aria-label="Confirmation code">{phase.enrolment.code}</p>
            <CopyBlock
              label={`In a terminal on ${machineName}, run:`}
              command={`codekin relay devices approve ${phase.enrolment.code}`}
            />
            <ul className="list-disc space-y-1 pl-5 text-meta text-ink-muted">
              <li>No screen on {machineName}? Run it over SSH, or ask a Codekin session running on {machineName} to run it.</li>
              <li>Or, in Codekin opened on {machineName} itself (not through this site): Settings → Remote access → Confirm a browser, and type the code there.</li>
              <li>If you just ran <code className="font-mono">codekin relay login</code>, it is asking for this code.</li>
            </ul>
            <form
              className="space-y-2 border-t border-edge pt-4"
              onSubmit={e => { e.preventDefault(); void finish() }}
            >
              <label htmlFor="trust-sheet-finish" className="block text-body text-ink">
                <span className="font-semibold">2.</span>{' '}
                {phase.accepted
                  ? `${machineName} accepted the code. Type the code it shows now to finish:`
                  : `${machineName} then shows a different, 6-character code. Type that one here to finish:`}
              </label>
              <div className="flex gap-2">
                <input
                  id="trust-sheet-finish"
                  value={typed}
                  onChange={e => { setTyped(e.target.value.toUpperCase()); setTypedWrong(false) }}
                  placeholder="XXX-XXX"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={9}
                  className="w-32 rounded-control border border-edge bg-page px-3 py-1.5 font-mono text-body tracking-widest text-ink focus:border-focus focus:outline-none"
                />
                <button type="submit" disabled={typed.replace(/[\s-]/g, '').length < 6} className={button}>Finish</button>
              </div>
              {typedWrong === 'own' && (
                <p className="text-meta text-warning-5">That is this browser's code. Type it on {machineName} first (step 1), then enter the 6-character code {machineName} shows.</p>
              )}
              {typedWrong === 'wrong' && <p className="text-meta text-warning-5">That isn't the code {machineName} showed. Check it and try again.</p>}
            </form>
            {!phase.accepted && (
              <p className="flex items-center gap-2 text-meta text-ink-faint">
                <IconLoader2 size={14} className="animate-spin" /> Waiting for the code… It expires in 10 minutes.
              </p>
            )}
            <p className="text-meta text-ink-faint">Computer key {phase.enrolment.machineKeyId}</p>
          </div>
        )}

        {phase.kind === 'done' && (
          phase.outcome === 'approved' ? (
            <div className="space-y-2">
              <p className="flex items-center gap-2 text-body text-success-5">
                <IconCircleCheckFilled size={18} /> This browser is confirmed on {machineName}.
              </p>
              <p className="text-meta text-ink-muted">
                Every browser, and the Codekin app, keeps its own key, so confirm each one you use with {machineName} the same way.
                If this was your first device there, {machineName} now accepts only confirmed devices.
                If your passkey was confirmed too, the others can use it instead of a code.
              </p>
            </div>
          ) : (
            <p className="text-body text-ink">
              {phase.outcome === 'rejected' ? `The request was turned down on ${machineName}.` : 'The code expired before it was typed.'}
            </p>
          )
        )}

        {phase.kind === 'failed' && (
          <p className="flex items-start gap-2 text-body text-warning-5">
            <IconAlertTriangle size={18} className="mt-0.5 shrink-0" /> {phase.message}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          {phase.kind === 'failed' && phase.keyChanged && (
            <button type="button" onClick={() => { void forgetOldKey() }} className={quietButton}>Forget the old key and start again</button>
          )}
          {phase.kind === 'failed' && phase.offerCode && (
            <button type="button" onClick={() => { setPhase({ kind: 'starting', waitingForMachine: false }); setMethod('code') }} className={button}>Use a code instead</button>
          )}
          {((phase.kind === 'done' && phase.outcome !== 'approved') || (phase.kind === 'failed' && !phase.keyChanged)) && (
            <button type="button" onClick={restart} className={button}>Start again</button>
          )}
          <button type="button" onClick={onClose} className={button}>{phase.kind === 'done' && phase.outcome === 'approved' ? 'Done' : 'Close'}</button>
        </div>
      </div>
    </div>
  )
}
