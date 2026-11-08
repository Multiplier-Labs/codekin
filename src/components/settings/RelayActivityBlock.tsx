/**
 * Settings → Remote access → Activity (docs/RELAY-SIGNED-INTENTS-AND-E2E-SPEC.md
 * §7.2): what the relay delivered to this machine and whether it carried a
 * valid signature from a confirmed browser. Read from the machine's own
 * hash-chained log, which the relay can't reach or change.
 */

import { useEffect, useState } from 'react'
import { IconAlertTriangle, IconCircleCheckFilled, IconCircleDashed } from '@tabler/icons-react'
import { getRelayIntents, verifyRelayIntents, type RelayIntentEntry } from '../../lib/ccApi'
import { Block } from './Block'

const plainButton = 'rounded-control border border-edge px-3 py-1.5 text-body text-ink hover:bg-surface-raised disabled:opacity-50 transition-colors'

const VERDICT: Record<RelayIntentEntry['verdict'], { label: string; tone: string }> = {
  accepted: { label: 'Signed', tone: 'text-success-5' },
  unsigned: { label: 'Unsigned', tone: 'text-ink-muted' },
  rejected: { label: 'Refused signature', tone: 'text-warning-5' },
}

interface Props {
  token: string
  /** keyId → device label, from the device list. */
  deviceLabels: Record<string, string>
}

export function RelayActivityBlock({ token, deviceLabels }: Props) {
  const [entries, setEntries] = useState<RelayIntentEntry[] | null>(null)
  const [onlyProblems, setOnlyProblems] = useState(false)
  const [chain, setChain] = useState<string | null>(null)

  useEffect(() => {
    if (!token) return
    const life = { stopped: false }
    // On failure the block stays hidden; the device list reports read errors.
    getRelayIntents(token, { limit: 50, ...(onlyProblems ? { verdict: 'rejected' as const } : {}) })
      .then(found => { if (!life.stopped) setEntries(found) })
      .catch(() => {})
    return () => { life.stopped = true }
  }, [token, onlyProblems])

  const check = async () => {
    try {
      const result = await verifyRelayIntents(token)
      setChain(result.ok
        ? `Intact: ${result.entries} entries, none changed or removed.`
        : `Broken at line ${result.problem?.line ?? '?'}: ${result.problem?.reason ?? 'unknown problem'}.`)
    } catch {
      setChain("Couldn't check the log.")
    }
  }

  if (entries === null) return null
  return (
    <Block
      title="Activity"
      description="What the relay delivered to this computer, and whether a confirmed browser signed it. Kept on this computer only."
      action={
        <div className="flex gap-2">
          <button type="button" onClick={() => { setOnlyProblems(p => !p) }} className={plainButton}>
            {onlyProblems ? 'Show all' : 'Only refused'}
          </button>
          <button type="button" onClick={() => { void check() }} className={plainButton}>Check log</button>
        </div>
      }
    >
      {chain && <p className="mb-3 text-meta text-ink-muted">{chain}</p>}
      {entries.length === 0 ? (
        <p className="text-body text-ink-muted">Nothing yet. Signed actions from confirmed browsers appear here.</p>
      ) : (
        <ul className="divide-y divide-edge">
          {entries.map(e => {
            const v = VERDICT[e.verdict]
            const Icon = e.verdict === 'accepted' ? IconCircleCheckFilled : e.verdict === 'rejected' ? IconAlertTriangle : IconCircleDashed
            return (
              <li key={e.seq} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-1.5 text-meta">
                <span className={`flex items-center gap-1 ${v.tone}`}><Icon size={14} /> {v.label}</span>
                <span className="font-mono text-ink">{e.action}</span>
                {e.keyId && <span className="text-ink-muted">{deviceLabels[e.keyId] ?? e.keyId}</span>}
                {e.stepUp && (
                  <span className={e.stepUp === 'passkey' ? 'text-ink-muted' : 'text-warning-5'}>
                    {e.stepUp === 'passkey' ? 'confirmed with passkey' : 'browser key only'}
                  </span>
                )}
                {e.reason && e.verdict === 'rejected' && <span className="text-warning-5">{e.reason}{e.forwarded ? ' (let through)' : ''}</span>}
                <span className="ml-auto text-ink-faint">{new Date(e.at).toLocaleTimeString()}</span>
              </li>
            )
          })}
        </ul>
      )}
    </Block>
  )
}
