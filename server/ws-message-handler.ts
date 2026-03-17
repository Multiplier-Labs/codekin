/**
 * WebSocket message handler — extracted from ws-server.ts for testability.
 *
 * Handles all client→server WebSocket message types (create_session, join_session,
 * input, prompt_response, etc.) via a typed context object instead of closure state.
 */

import type { WebSocket } from 'ws'
import type { SessionManager } from './session-manager.js'
import { VALID_MODELS, VALID_PERMISSION_MODES } from './types.js'
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
      const session = sessions.create(msg.name, msg.workingDir, { model: msg.model, permissionMode: msg.permissionMode })
      session.clients.add(ws)
      clientSessions.set(ws, session.id)

      if (msg.useWorktree) {
        // Create worktree asynchronously, then start Claude in it
        void sessions.createWorktree(session.id, msg.workingDir).then((wtPath) => {
          if (wtPath) {
            send({
              type: 'session_created',
              sessionId: session.id,
              sessionName: session.name,
              workingDir: session.workingDir,
            })
          } else {
            // Worktree creation failed — fall back to main directory
            send({ type: 'system_message', subtype: 'error', text: 'Failed to create git worktree. Using main project directory.' })
            send({
              type: 'session_created',
              sessionId: session.id,
              sessionName: session.name,
              workingDir: session.workingDir,
            })
          }
          sessions.startClaude(session.id)
        })
      } else {
        send({
          type: 'session_created',
          sessionId: session.id,
          sessionName: session.name,
          workingDir: session.workingDir,
        })
        sessions.startClaude(session.id)
      }
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
          model: session.model,
          permissionMode: session.permissionMode,
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
        if (!VALID_MODELS.has(msg.model)) {
          send({ type: 'error', message: `Invalid model: ${msg.model}` })
          break
        }
        sessions.setModel(sessionId, msg.model)
      }
      break
    }

    case 'set_permission_mode': {
      const sessionId = clientSessions.get(ws)
      if (sessionId) {
        if (!VALID_PERMISSION_MODES.has(msg.permissionMode)) {
          send({ type: 'error', message: `Invalid permission mode: ${msg.permissionMode}` })
          break
        }
        sessions.setPermissionMode(sessionId, msg.permissionMode)
      }
      break
    }

    case 'resize':
      // stream-json mode doesn't use PTY, so resize is a no-op
      break

    case 'ping':
      send({ type: 'pong' })
      break

    case 'get_diff': {
      const sessionId = clientSessions.get(ws)
      if (sessionId) {
        void sessions.getDiff(sessionId, msg.scope).then(result => { send(result) })
      } else {
        send({ type: 'diff_error', message: 'Not in a session' })
      }
      break
    }

    case 'move_to_worktree': {
      const sessionId = clientSessions.get(ws)
      if (!sessionId) { send({ type: 'error', message: 'Not in a session' }); break }
      const session = sessions.get(sessionId)
      if (!session) { send({ type: 'error', message: 'Session not found' }); break }
      if (session.worktreePath) { send({ type: 'error', message: 'Session is already in a worktree' }); break }

      const originalDir = session.workingDir
      // Wait for the old process to fully exit before creating the worktree
      // and restarting, to avoid "Session ID already in use" errors.
      void sessions.stopClaudeAndWait(sessionId).then(() => {
        // Keep claudeSessionId so Claude CLI resumes with full conversation
        // context after the restart.  stopClaudeAndWait() already awaits
        // process exit, so the session lock should be released.
        return sessions.createWorktree(sessionId, originalDir)
      }).then((wtPath) => {
        if (wtPath) {
          const wtName = wtPath.split('/').pop() ?? wtPath
          const createdMsg = { type: 'worktree_created' as const, worktreePath: wtPath, workingDir: wtPath }
          sessions.broadcast(session, createdMsg)
          const notifMsg = { type: 'system_message' as const, subtype: 'notification' as const, text: `Moved to worktree: ${wtName}` }
          sessions.addToHistory(session, notifMsg)
          sessions.broadcast(session, notifMsg)
        } else {
          send({ type: 'system_message', subtype: 'error', text: 'Failed to create worktree. Check server logs for details.' })
        }
        // Always restart Claude — in the worktree on success, or original dir on failure
        sessions.startClaude(sessionId)
      }).catch((err) => {
        console.error('[worktree] move_to_worktree failed:', err)
        send({ type: 'system_message', subtype: 'error', text: 'Failed to move to worktree.' })
        sessions.startClaude(sessionId)
      })
      break
    }

    case 'discard_changes': {
      const sessionId = clientSessions.get(ws)
      if (sessionId) {
        void sessions.discardChanges(sessionId, msg.scope, msg.paths, msg.statuses).then(result => { send(result) })
      } else {
        send({ type: 'diff_error', message: 'Not in a session' })
      }
      break
    }

  }
}
