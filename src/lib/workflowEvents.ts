/**
 * In-page bridge for server-pushed workflow events.
 *
 * The server broadcasts `workflow_event` frames to every WebSocket client, but
 * the socket lives in App (useChatSocket) while the consumer (useWorkflows)
 * lives behind the Workflows view. This module carries the event across that
 * gap without threading props through the tree: App publishes every
 * `workflow_event` it receives, useWorkflows subscribes and refreshes.
 *
 * Deliberately not a React context — the socket and the view mount in
 * different subtrees, and a module-level emitter keeps the wiring one line
 * on each side.
 */

import type { WsServerMessage } from '../types'

export type WorkflowEventMsg = Extract<WsServerMessage, { type: 'workflow_event' }>

type Listener = (event: WorkflowEventMsg) => void

const listeners = new Set<Listener>()

/** Publish a workflow event to all subscribers. Called from the WS message handler. */
export function emitWorkflowEvent(event: WorkflowEventMsg): void {
  for (const listener of [...listeners]) listener(event)
}

/** Subscribe to workflow events. Returns an unsubscribe function. */
export function subscribeWorkflowEvents(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
