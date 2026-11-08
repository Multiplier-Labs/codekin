/**
 * Settings → Remote access → "Devices that can control this computer"
 * (docs/RELAY-SIGNED-INTENTS-AND-E2E-SPEC.md §5.5). The machine's own list of
 * browsers and passkeys allowed to act on it through the relay, read from
 * relay-devices.json by the local server. Local only: the relay can't reach
 * /api/relay/*.
 *
 * Read-only plus remove for now. Adding a device needs the enrolment
 * ceremony, which comes next, and nothing is enforced yet.
 */

import { useCallback, useEffect, useState } from 'react'
import { getRelayDevices, revokeRelayDevice, type RelayDevices, type RelayDevice } from '../../lib/ccApi'
import { Block, Row, Rows } from './Block'

const plainButton = 'rounded-control border border-edge px-3 py-1.5 text-body text-ink hover:bg-surface-raised disabled:opacity-50 transition-colors'

function addedByText(addedBy: string): string {
  if (addedBy === 'local') return 'confirmed on this computer'
  if (addedBy.startsWith('passkey:')) return 'added by passkey'
  return addedBy
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

interface Props {
  token: string
  onError: (message: string) => void
}

export function RelayDevicesBlock({ token, onError }: Props) {
  const [data, setData] = useState<RelayDevices | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setData(await getRelayDevices(token))
  }, [token])

  useEffect(() => {
    if (!token) return
    refresh().catch(() => { onError("Couldn't read this computer's device list") })
  }, [token, refresh, onError])

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
  return (
    <Block
      title="Devices that can control this computer"
      description="Browsers and passkeys confirmed on this computer. Codekin doesn't check them yet: for now the relay is still trusted to say who is in control."
    >
      <Rows>
        <Row
          label="This computer's identity key"
          description="Browsers will check this key when you confirm them."
          control={<span className="font-mono text-meta text-ink-muted">{data.identity?.keyId ?? 'Created when the connector starts'}</span>}
        />
        {data.error && (
          <Row label="Device list unreadable" description={data.error} />
        )}
        {!data.error && devices.length === 0 && (
          <Row
            label="No devices yet"
            description="You'll add a browser by typing a code it shows into this computer. That comes in a later update."
          />
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
  )
}
