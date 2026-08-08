/**
 * Active transport singleton.
 *
 * Local mode is the only implementation today. Hosted relay mode
 * (docs/HOSTED-RELAY-CONTROL-PLANE-SPEC.md §9.3) will select a
 * HostedRelayTransport here based on the build mode.
 */

import { LocalHttpTransport } from './local'
import type { CodekinTransport } from './types'

export type { CodekinTransport } from './types'
export { LocalHttpTransport } from './local'

export const transport: CodekinTransport = new LocalHttpTransport()
