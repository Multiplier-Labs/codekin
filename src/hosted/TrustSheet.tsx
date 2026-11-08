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
  EnrolmentFailure, currentUserId, deviceTrustSupported, startEnrolment, trustStorage, type Enrolment,
} from './deviceTrust'
import { button, quietButton } from '../components/settings/Block'

const POLL_MS = 2000
/** The machine drops an undecided request after 10 minutes. */
const REQUEST_TTL_MS = 10 * 60_000 + 30_000
/** How long to keep retrying while the machine comes online (just paired). */
const ONLINE_WAIT_MS = 90_000

type Phase =
  | { kind: 'starting'; waitingForMachine: boolean }
  | { kind: 'code'; enrolment: Enrolment }
  | { kind: 'done'; outcome: 'approved' | 'rejected' | 'expired' }
  | { kind: 'failed'; message: string; keyChanged?: boolean }

interface TrustSheetProps {
  machineId: string
  machineName: string
  onClose: () => void
  /** Called once the machine confirmed this browser. */
  onTrusted?: () => void
}

function describeError(err: unknown): string {
  if (err instanceof EnrolmentFailure) return err.message
  if (err instanceof RelayRequestError) {
    if (err.code === 'connector_update_required') return 'Update Codekin on that computer to confirm browsers on it.'
    return err.message
  }
  return err instanceof Error ? err.message : 'Something went wrong'
}

const retryable = (err: unknown) => err instanceof RelayRequestError && ['machine_offline', 'timeout', 'disconnected'].includes(err.code)

export function TrustSheet({ machineId, machineName, onClose, onTrusted }: TrustSheetProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'starting', waitingForMachine: false })
  const [attempt, setAttempt] = useState(0)
  const connection = useRef<RelayConnection | null>(null)

  useEffect(() => {
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
      for (;;) {
        try {
          const enrolment = await startEnrolment((kind, payload) => conn.enrol(kind, payload), { userId, machineId })
          if (!stopped()) setPhase({ kind: 'code', enrolment })
          return
        } catch (err) {
          if (stopped()) return
          if (retryable(err) && Date.now() < deadline) {
            setPhase({ kind: 'starting', waitingForMachine: true })
            await new Promise(r => setTimeout(r, 3000))
            if (stopped()) return
            continue
          }
          setPhase({ kind: 'failed', message: describeError(err), keyChanged: err instanceof EnrolmentFailure && err.code === 'machine_key_changed' })
          return
        }
      }
    })()

    return () => {
      life.cancelled = true
      conn.close()
      connection.current = null
    }
  }, [machineId, attempt])

  // Ask the machine whether the code was typed, one question at a time
  // (a slow relay must not pile them up), until it decides or the request
  // expires.
  useEffect(() => {
    if (phase.kind !== 'code') return
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
          setPhase({ kind: 'done', outcome })
          if (outcome === 'approved') onTrusted?.()
        })
        .catch((err: unknown) => {
          if (life.stopped) return
          if (retryable(err)) timer = setTimeout(ask, POLL_MS)
          else setPhase({ kind: 'failed', message: describeError(err) })
        })
    }
    timer = setTimeout(ask, POLL_MS)
    return () => { life.stopped = true; clearTimeout(timer) }
  }, [phase, onTrusted])

  const forgetOldKey = useCallback(async () => {
    const userId = await currentUserId()
    if (userId) await trustStorage().deletePin(userId, machineId)
    setPhase({ kind: 'starting', waitingForMachine: false })
    setAttempt(a => a + 1)
  }, [machineId])

  const restart = () => {
    setPhase({ kind: 'starting', waitingForMachine: false })
    setAttempt(a => a + 1)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-page/80 p-4" role="dialog" aria-modal="true" aria-labelledby="trust-sheet-title">
      <div className="w-full max-w-md rounded-floating border border-edge-strong bg-surface-raised p-6 shadow-floating">
        <h2 id="trust-sheet-title" className="mb-2 text-title font-semibold text-ink">Confirm this browser on {machineName}</h2>

        {phase.kind === 'starting' && (
          <p className="flex items-center gap-2 text-body text-ink-muted">
            <IconLoader2 size={16} className="animate-spin" />
            {phase.waitingForMachine ? `Waiting for ${machineName} to come online…` : 'Preparing a code…'}
          </p>
        )}

        {phase.kind === 'code' && (
          <div className="space-y-4">
            <p className="text-body text-ink-muted">Type this code on {machineName} to let this browser control it:</p>
            <p className="text-center font-mono text-head tracking-widest text-ink" aria-label="Confirmation code">{phase.enrolment.code}</p>
            <ul className="list-disc space-y-1 pl-5 text-meta text-ink-muted">
              <li>In Codekin on that computer: Settings → Remote access → Confirm a browser.</li>
              <li>Or in a terminal there: <code className="font-mono text-ink">codekin relay devices approve {phase.enrolment.code}</code></li>
              <li>If you just ran <code className="font-mono">codekin relay login</code>, it is asking for this code.</li>
            </ul>
            <p className="flex items-center gap-2 text-meta text-ink-faint">
              <IconLoader2 size={14} className="animate-spin" /> Waiting for the code… It expires in 10 minutes.
            </p>
            <p className="text-meta text-ink-faint">Computer key {phase.enrolment.machineKeyId}</p>
          </div>
        )}

        {phase.kind === 'done' && (
          phase.outcome === 'approved' ? (
            <p className="flex items-center gap-2 text-body text-success-5">
              <IconCircleCheckFilled size={18} /> This browser is confirmed on {machineName}.
            </p>
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
          {((phase.kind === 'done' && phase.outcome !== 'approved') || (phase.kind === 'failed' && !phase.keyChanged)) && (
            <button type="button" onClick={restart} className={button}>Start again</button>
          )}
          <button type="button" onClick={onClose} className={button}>{phase.kind === 'done' && phase.outcome === 'approved' ? 'Done' : 'Close'}</button>
        </div>
      </div>
    </div>
  )
}
