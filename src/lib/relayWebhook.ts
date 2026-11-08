/**
 * The relay's GitHub webhook receiver for a machine (hosted mode only;
 * docs/SELF-HOSTED-RELAY.md, "GitHub webhooks"). These are same-origin calls
 * to the relay's own API, not proxied to the machine.
 */

export interface RelayWebhook {
  enabled: boolean
  createdAt: string | null
  lastDeliveryAt: string | null
  /** Receiver URL to give GitHub; null when off (or for an old receiver that needs a new URL). */
  url: string | null
}

export class RelayWebhookError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`Relay webhook request failed (${status})`)
    this.name = 'RelayWebhookError'
    this.status = status
  }
}

async function call(machineId: string, method: 'GET' | 'POST' | 'DELETE'): Promise<RelayWebhook> {
  const res = await fetch(`/api/machines/${encodeURIComponent(machineId)}/webhook`, { method, credentials: 'include' })
  if (!res.ok) throw new RelayWebhookError(res.status)
  return (await res.json()) as RelayWebhook
}

export const fetchRelayWebhook = (machineId: string) => call(machineId, 'GET')
/** Turn the receiver on, or replace its URL. The old URL stops working at once. */
export const enableRelayWebhook = (machineId: string) => call(machineId, 'POST')
export const disableRelayWebhook = (machineId: string) => call(machineId, 'DELETE')
