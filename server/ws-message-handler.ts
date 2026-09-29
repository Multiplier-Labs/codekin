/**
 * WebSocket message handler — extracted from ws-server.ts for testability.
 *
 * Handles all client→server WebSocket message types (create_session, join_session,
 * input, prompt_response, etc.) via a typed context object instead of closure state.
 */

import { realpathSync as fsRealpathSync } from 'fs'
import { homedir as osHomedir } from 'os'
import { resolve as pathResolve } from 'path'
import type { WebSocket } from 'ws'
import { getDefaultClaudeModel, triggerCliProbeIfNeeded } from './anthropic-models.js'
import { REPOS_ROOT } from './config.js'
import { isDiffView } from './diff-manager.js'
import { isOrchestratorSession, setOrchestratorModel, setOrchestratorProvider } from './orchestrator-manager.js'
import type { ReviewAuthor } from './review-comments.js'
import type { SessionManager } from './session-manager.js'
import { VALID_PERMISSION_MODES, VALID_PROVIDERS } from './types.js'
import type { WsClientMessage, WsServerMessage } from './types.js'

/** Closure state passed to handleWsMessage from the ws.on('connection') scope. */
export interface WsHandlerContext {
  ws: WebSocket
  sessions: SessionManager
  clientSessions: Map<WebSocket, string>
  send: (msg: WsServerMessage) => void
}

/**
 * Who wrote a review comment. The relay connector stamps relayUser/relayRole
 * on every review frame from a remote browser (overwriting anything the
 * browser sent); a direct local client is the machine owner.
 */
function reviewAuthor(msg: { relayUser?: string; relayRole?: 'owner' | 'grantee' }): ReviewAuthor {
  return msg.relayRole === 'grantee'
    ? { id: typeof msg.relayUser === 'string' && msg.relayUser ? msg.relayUser : 'unknown', role: 'grantee' }
    : { id: typeof msg.relayUser === 'string' && msg.relayUser ? msg.relayUser : 'owner', role: 'owner' }
}

/** Route a single parsed client message to the appropriate session manager method. */
export function handleWsMessage(msg: WsClientMessage, ctx: WsHandlerContext): void {
  const { ws, sessions, clientSessions, send } = ctx

  switch (msg.type) {
    // Create a new session, optionally in a git worktree, then start Claude.
    case 'create_session': {
      // Bounds-check: workingDir must be under home or REPOS_ROOT
      const home = osHomedir()
      const allowedRoots = [home, REPOS_ROOT]
      let resolvedDir: string
      try {
        resolvedDir = fsRealpathSync(pathResolve(msg.workingDir))
      } catch {
        send({ type: 'error', message: 'workingDir could not be resolved (path does not exist or is inaccessible)' })
        break
      }
      if (!allowedRoots.some(root => resolvedDir === root || resolvedDir.startsWith(root + '/'))) {
        send({ type: 'error', message: 'workingDir is outside allowed directories' })
        break
      }

      if (msg.provider && !VALID_PROVIDERS.has(msg.provider)) {
        send({ type: 'error', message: `Invalid provider: ${msg.provider}` })
        break
      }
      if (msg.permissionMode && !VALID_PERMISSION_MODES.has(msg.permissionMode)) {
        send({ type: 'error', message: `Invalid permission mode: ${msg.permissionMode}` })
        break
      }
      // Default new Claude sessions to the latest known model so the CLI starts
      // on it directly. Without this the CLI picks a stale default (e.g. opus-4-6)
      // and the client's model-validation effect switches it post-start, which
      // restarts the process and drops the user's first message.
      const provider = msg.provider ?? 'claude'
      const model = msg.model ?? (provider === 'claude' ? getDefaultClaudeModel() : undefined)
      // Use the security-checked canonical path (not the raw msg.workingDir) so
      // grouping/archive behavior stays consistent with the resolved directory.
      const session = sessions.create(msg.name, resolvedDir, { model, permissionMode: msg.permissionMode, allowedTools: msg.allowedTools, provider: msg.provider, useWorktree: msg.useWorktree })
      session.clients.add(ws)
      clientSessions.set(ws, session.id)

      // Trigger background CLI probe to discover latest model IDs (once per day)
      triggerCliProbeIfNeeded()

      if (msg.useWorktree) {
        // Create the worktree, then start Claude in it. An isolated session
        // never falls back to the shared checkout: on failure it stays
        // stopped (input is held) until the user retries or switches.
        void sessions.prepareSessionWorktree(session.id, resolvedDir).then((result) => {
          if (sessions.get(session.id) !== session) return  // deleted meanwhile
          send({
            type: 'session_created',
            sessionId: session.id,
            sessionName: session.name,
            workingDir: session.workingDir,
          })
          if (result.ok) {
            sessions.startClaude(session.id)
          } else {
            send({
              type: 'system_message',
              subtype: 'error',
              text: `Could not create an isolated worktree: ${result.message} Nothing was started in the shared checkout. Retry, or switch this session to the shared checkout.`,
            })
          }
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

    // Join an existing session — leave the previous one first to avoid dual membership.
    // Sends back the full output history so the client can rebuild the chat view.
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
          provider: session.provider,
          permissionMode: session.permissionMode,
          planState: session.planManager.state,
        })
      } else {
        send({ type: 'error', message: 'Session not found' })
      }
      break
    }

    // Cleanly leave the current session without destroying it (session stays alive for other clients).
    case 'leave_session': {
      const currentId = clientSessions.get(ws)
      if (currentId) {
        sessions.leave(currentId, ws)
        clientSessions.delete(ws)
        send({ type: 'session_left' })
      }
      break
    }

    // (Re)start the Claude process for the current session (e.g. after a stop or crash).
    case 'start_claude': {
      const sessionId = clientSessions.get(ws)
      if (sessionId) {
        sessions.startClaude(sessionId)
      } else {
        send({ type: 'error', message: 'Not in a session' })
      }
      break
    }

    // Kill the Claude process for the current session (user-initiated stop).
    case 'stop': {
      const sessionId = clientSessions.get(ws)
      if (sessionId) {
        sessions.stopClaude(sessionId)
      }
      break
    }

    // Forward user input to the Claude stdin pipe and echo back to all connected clients.
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

    // Route a tool-approval or permission prompt response back to the Claude process.
    // The requestId ties it to a specific pending approval.
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

    // Change the model for the session. Basic sanity check on model ID format.
    case 'set_model': {
      const sessionId = clientSessions.get(ws)
      if (sessionId) {
        // Accept any non-empty model string — models are fetched dynamically
        // from the Anthropic API so we can't validate against a static list.
        if (!msg.model || typeof msg.model !== 'string') {
          send({ type: 'error', message: `Invalid model: ${msg.model}` })
          break
        }
        sessions.setModel(sessionId, msg.model)
        // The orchestrator's model is a standing preference, not a per-session
        // one — its session is recreated on demand, so persist the choice.
        if (isOrchestratorSession(sessions.get(sessionId)?.source)) {
          setOrchestratorModel(sessions, msg.model)
        }
      }
      break
    }

    // Change the AI provider for the session. Stops old process and restarts with new provider.
    case 'set_provider': {
      const sessionId = clientSessions.get(ws)
      if (sessionId) {
        if (!VALID_PROVIDERS.has(msg.provider)) {
          send({ type: 'error', message: `Invalid provider: ${msg.provider}` })
          break
        }
        sessions.setProvider(sessionId, msg.provider, msg.carryContext)
        // The orchestrator's harness is a standing preference, not a per-session
        // one — its session is recreated on demand, so persist the choice.
        if (isOrchestratorSession(sessions.get(sessionId)?.source)) {
          setOrchestratorProvider(sessions, msg.provider)
        }
      }
      break
    }

    // Change the permission mode for the session. Validated against the server-side allowlist.
    case 'set_permission_mode': {
      const sessionId = clientSessions.get(ws)
      if (sessionId) {
        if (msg.permissionMode && !VALID_PERMISSION_MODES.has(msg.permissionMode)) {
          send({ type: 'error', message: `Invalid permission mode: ${msg.permissionMode}` })
          break
        }
        sessions.setPermissionMode(sessionId, msg.permissionMode)
      }
      break
    }

    // No-op: stream-json mode doesn't use a PTY, so terminal resize has no effect.
    // Kept as a recognized message type so the client doesn't need to guard against it.
    case 'resize':
      break

    // Health-check / keep-alive: client pings periodically and on visibility restore.
    case 'ping':
      send({ type: 'pong' })
      break

    // Compute git diff for the session's working directory and return structured results.
    // Diff responses carry the request and session they answer, so a client
    // that has since switched session or view can drop late results.
    case 'get_diff': {
      const sessionId = clientSessions.get(ws)
      const { requestId } = msg
      const view = msg.scope ?? 'all'
      if (!sessionId) { send({ type: 'diff_error', message: 'Not in a session', requestId }); break }
      if (!isDiffView(view)) { send({ type: 'diff_error', message: `Unknown diff view: ${String(view)}`, requestId, sessionId }); break }
      void sessions.getDiff(sessionId, view).then(result => { send({ ...result, requestId, sessionId } as WsServerMessage) })
      break
    }

    case 'get_pr_status': {
      const sessionId = clientSessions.get(ws)
      const { requestId } = msg
      if (!sessionId) { send({ type: 'error', message: 'Not in a session' }); break }
      void sessions.getPrStatus(sessionId, msg.refresh === true).then(status => {
        if (status) send({ type: 'pr_status', status, requestId, sessionId })
      })
      break
    }

    // --- Review comments: anchored drafts, sent to the agent as one prompt ---

    case 'review_comments_get': {
      const sessionId = clientSessions.get(ws)
      if (!sessionId) { send({ type: 'review_error', message: 'Not in a session' }); break }
      void sessions.listReviewComments(sessionId).then(comments => {
        if (comments) send({ type: 'review_comments', sessionId, comments })
      })
      break
    }

    case 'review_comment_add':
    case 'review_comment_update':
    case 'review_comment_delete':
    case 'review_feedback_send': {
      const sessionId = clientSessions.get(ws)
      if (!sessionId) { send({ type: 'review_error', message: 'Not in a session' }); break }
      const author = reviewAuthor(msg)
      const done = (error: string | null) => { if (error) send({ type: 'review_error', message: error, sessionId }) }
      if (msg.type === 'review_comment_add') {
        const { path, side, startLine, endLine, view, baseCommit, headCommit } = msg
        if (!isDiffView(view)) { done(`Unknown diff view: ${String(view)}`); break }
        void sessions.addReviewComment(sessionId, { path, side, startLine, endLine, view, baseCommit, headCommit }, msg.body, author).then(done)
      } else if (msg.type === 'review_comment_update') {
        void sessions.updateReviewComment(sessionId, msg.id, msg.body, author).then(done)
      } else if (msg.type === 'review_comment_delete') {
        void sessions.deleteReviewComment(sessionId, msg.id, author).then(done)
      } else {
        const ids = Array.isArray(msg.ids) ? msg.ids.filter((id): id is string => typeof id === 'string') : undefined
        void sessions.sendReviewFeedback(sessionId, { ids, includeStale: msg.includeStale === true }).then(done)
      }
      break
    }

    case 'set_review_base': {
      const sessionId = clientSessions.get(ws)
      const { requestId, scope: view } = msg
      if (!sessionId) { send({ type: 'diff_error', message: 'Not in a session', requestId }); break }
      if (!isDiffView(view)) { send({ type: 'diff_error', message: `Unknown diff view: ${String(view)}`, requestId, sessionId }); break }
      const base = typeof msg.base === 'string' && msg.base.trim() ? msg.base.trim() : null
      void sessions.setReviewBase(sessionId, base).then(async (error) => {
        if (error) { send({ type: 'diff_error', message: error, scope: view, requestId, sessionId }); return }
        const result = await sessions.getDiff(sessionId, view)
        send({ ...result, requestId, sessionId } as WsServerMessage)
      })
      break
    }

    // Move a running session into a git worktree mid-conversation.
    // Stops the Claude process first, creates the worktree, then restarts Claude in it.
    // Preserves the Claude session ID so the CLI resumes with full conversation context.
    // Recover an isolated session whose worktree failed or disappeared.
    case 'retry_worktree': {
      const sessionId = clientSessions.get(ws)
      if (!sessionId) { send({ type: 'error', message: 'Not in a session' }); break }
      void sessions.retryWorktree(sessionId).then((result) => {
        if (!result.ok) {
          send({ type: 'system_message', subtype: 'error', text: `Worktree retry failed: ${result.message}` })
        }
      })
      break
    }

    // Explicit, user-chosen switch of an isolated session to the shared checkout.
    case 'use_existing_checkout': {
      const sessionId = clientSessions.get(ws)
      if (!sessionId) { send({ type: 'error', message: 'Not in a session' }); break }
      if (!sessions.useExistingCheckout(sessionId)) {
        send({ type: 'error', message: 'Session cannot switch to the shared checkout right now' })
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
        return sessions.prepareSessionWorktree(sessionId, originalDir)
      }).then((result) => {
        if (result.ok) {
          const wtName = result.path.split('/').pop() ?? result.path
          const createdMsg = { type: 'worktree_created' as const, worktreePath: result.path, workingDir: result.path }
          sessions.broadcast(session, createdMsg)
          const notifMsg = { type: 'system_message' as const, subtype: 'notification' as const, text: `Moved to worktree: ${wtName}` }
          sessions.addToHistory(session, notifMsg)
          sessions.broadcast(session, notifMsg)
        } else {
          send({ type: 'system_message', subtype: 'error', text: `Failed to create worktree: ${result.message} Continuing in the current checkout.` })
        }
        // Restart Claude — in the worktree on success, or where it already was
        // on failure (the session was not isolated before the move).
        sessions.startClaude(sessionId)
      }).catch((err) => {
        console.error('[worktree] move_to_worktree failed:', err)
        send({ type: 'system_message', subtype: 'error', text: 'Failed to move to worktree.' })
        sessions.startClaude(sessionId)
      })
      break
    }

    // Discard uncommitted changes (git checkout/clean) for specified paths in the session's repo.
    case 'discard_changes': {
      const sessionId = clientSessions.get(ws)
      if (sessionId) {
        void sessions.discardChanges(sessionId, msg.scope, msg.paths, msg.statuses).then(result => { send({ ...result, sessionId } as WsServerMessage) })
      } else {
        send({ type: 'diff_error', message: 'Not in a session' })
      }
      break
    }

  }
}
