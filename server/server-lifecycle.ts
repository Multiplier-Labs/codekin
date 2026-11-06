/**
 * In-process lifecycle signals from the main server.
 *
 * The desktop app's launcher (`codekin app-server`, bin/lib/app-server.mjs)
 * imports ws-server.js into its own process. It subscribes here first, so it
 * learns when the HTTP server is really listening (before any readiness
 * check) or why it couldn't bind, instead of guessing from a port probe that
 * another process could answer. Other entry points ignore these events.
 */

import { EventEmitter } from 'events'

export interface ListeningInfo {
  host: string
  port: number
}

export interface ServerLifecycleEvents {
  listening: [ListeningInfo]
  listen_error: [NodeJS.ErrnoException]
}

export const serverLifecycle = new EventEmitter<ServerLifecycleEvents>()
