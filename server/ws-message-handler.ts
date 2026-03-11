/**
 * WebSocket message handler — extracted from ws-server.ts for testability.
 *
 * Handles all client→server WebSocket message types (create_session, join_session,
 * input, prompt_response, etc.) via a typed context object instead of closure state.
 */

import type { WebSocket } from 'ws'
import type { SessionManager } from './session-manager.js'
import type { WsClientMessage, WsServerMessage } from './types.js'

/** Closure state passed to handleWsMessage from the ws.on('connection') scope. */
export interface WsHandlerContext {
  ws: WebSocket
  sessions: SessionManager
  clientSessions: Map<WebSocket, string>
  send: (msg: WsServerMessage) => void
}

/** Route a single parsed client message to the appropriate session manager method. */
export function handleWsMessage(msg: WsClientMessage, ctx: WsHandlerContext): void {
  const { ws, sessions, clientSessions, send } = ctx

  switch (msg.type) {
    case 'create_session': {
      const session = sessions.create(msg.name, msg.workingDir, { model: msg.model })
      session.clients.add(ws)
      clientSessions.set(ws, session.id)
      send({
        type: 'session_created',
        sessionId: session.id,
        sessionName: session.name,
        workingDir: session.workingDir,
      })
      sessions.startClaude(session.id)
      break
    }

    case 'join_session': {
      const currentId = clientSessions.get(ws)
      if (currentId) {
        sessions.leave(currentId, ws)
      }
      const session = sessions.join(msg.sessionId, ws)
      if (session) {
        clientSessions.set(ws, session.id)
        send({
          type: 'session_joined',
          sessionId: session.id,
          sessionName: session.name,
          workingDir: session.workingDir,
          active: session.claudeProcess?.isAlive() ?? false,
          outputBuffer: session.outputHistory.slice(-500),
        })
      } else {
        send({ type: 'error', message: 'Session not found' })
      }
      break
    }

    case 'leave_session': {
      const currentId = clientSessions.get(ws)
      if (currentId) {
        sessions.leave(currentId, ws)
        clientSessions.delete(ws)
        send({ type: 'session_left' })
      }
      break
    }

    case 'start_claude': {
      const sessionId = clientSessions.get(ws)
      if (sessionId) {
        sessions.startClaude(sessionId)
      } else {
        send({ type: 'error', message: 'Not in a session' })
      }
      break
    }

    case 'stop': {
      const sessionId = clientSessions.get(ws)
      if (sessionId) {
        sessions.stopClaude(sessionId)
      }
      break
    }

    case 'input': {
      const sessionId = clientSessions.get(ws)
      if (sessionId) {
        const session = sessions.get(sessionId)
        if (session) {
          const displayText = typeof msg.displayText === 'string' ? msg.displayText : undefined
          const echoMsg: WsServerMessage = { type: 'user_echo', text: displayText || msg.data }
          sessions.addToHistory(session, echoMsg)
          sessions.broadcast(session, echoMsg)
        }
        sessions.sendInput(sessionId, msg.data)
      }
      break
    }

    case 'prompt_response': {
      const sessionId = clientSessions.get(ws)
      console.log(`[prompt_response] sessionId=${sessionId} value=${JSON.stringify(msg.value)} requestId=${msg.requestId}`)
      if (sessionId) {
        sessions.sendPromptResponse(sessionId, msg.value, msg.requestId)
      } else {
        console.warn('[prompt_response] no session found for client')
      }
      break
    }

    case 'set_model': {
      const sessionId = clientSessions.get(ws)
      if (sessionId) {
        sessions.setModel(sessionId, msg.model)
      }
      break
    }

    case 'resize':
      // stream-json mode doesn't use PTY, so resize is a no-op
      break

    case 'ping':
      send({ type: 'pong' })
      break

  }
}
