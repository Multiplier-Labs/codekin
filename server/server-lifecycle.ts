/**
 * In-process lifecycle signals from the main server.
 *
 * The desktop app's launcher (`codekin app-server`, bin/lib/app-server.mjs)
 * imports ws-server.js into its own process. It subscribes here first, so it
 * learns why the server couldn't own its state directories, when the HTTP
 * server is really listening (before any readiness check) or why it couldn't
 * bind, instead of guessing from a port probe that another process could
 * answer. Other entry points ignore these events.
 */

import { EventEmitter } from 'events'
import type { OwnershipError } from './data-ownership.js'

export interface ListeningInfo {
  host: string
  port: number
}

export interface ServerLifecycleEvents {
  listening: [ListeningInfo]
  listen_error: [NodeJS.ErrnoException]
  /** Another server owns a state directory, or it holds newer data. The server exits right after. */
  ownership_error: [OwnershipError]
}

export const serverLifecycle = new EventEmitter<ServerLifecycleEvents>()
