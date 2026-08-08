/**
 * Active transport singleton.
 *
 * Local mode installs the LocalHttpTransport at import time. The hosted app
 * (docs/HOSTED-RELAY-CONTROL-PLANE-SPEC.md §9.3) swaps in a
 * HostedRelayTransport once the user picks a machine — consumers import the
 * live binding and read it per call, so the swap is transparent to them.
 */

import { LocalHttpTransport } from './local'
import type { CodekinTransport } from './types'

export type { CodekinTransport } from './types'
export { LocalHttpTransport } from './local'
export { HostedRelayTransport } from './hosted'

export let transport: CodekinTransport = new LocalHttpTransport()

/** Install a different transport (hosted mode machine selection). */
export function setTransport(next: CodekinTransport): void {
  transport = next
}
