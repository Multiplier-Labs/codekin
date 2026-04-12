/**
 * Core WebSocket hook for Codekin chat sessions.
 *
 * Manages session join/leave/create, sending user input and prompt responses,
 * and converting raw WsServerMessage events into ChatMessage[] for the UI.
 *
 * Text streaming is batched via requestAnimationFrame for ~60fps rendering
 * without flooding React state updates on every small text delta.
 *
 * Transport lifecycle (connect/reconnect/auth/ping) is delegated to
 * useWsConnection, keeping this hook focused on session-level concerns.
 */

import { useRef, useCallback, useEffect, useState } from 'react'
import type { WsClientMessage, WsServerMessage, ChatMessage, TaskItem, PermissionMode } from '../types'
import { usePromptState } from './usePromptState'
import { useWsConnection } from './useWsConnection'

/** Max chat messages kept in the browser before trimming older entries. */
const MAX_BROWSER_MESSAGES = 500

/** Monotonically increasing counter for stable React keys across trims. */
let msgKeyCounter = 0
function nextKey(): string { return `m${++msgKeyCounter}` }

interface UseChatSocketOptions {
  token: string
  onSessionCreated?: (sessionId: string) => void
  onSessionJoined?: (sessionId: string) => void
  onSessionRenamed?: (sessionId: string, name: string) => void
  onSessionsUpdated?: () => void
  onError?: (msg: string) => void
  /** Called for every raw incoming WsServerMessage (for external consumers like useDiff). */
  onRawMessage?: (msg: WsServerMessage) => void
}

/**
 * Core message application logic — mutates `messages` array in place.
 * Returns true if the array was modified (element added or existing element changed).
 * Both processMessage (immutable wrapper) and rebuildFromHistory use this
 * to eliminate the duplicated switch logic.
 */
function applyMessageMut(messages: ChatMessage[], msg: WsServerMessage): boolean {
  const last = messages.length > 0 ? messages[messages.length - 1] : undefined

  switch (msg.type) {
    case 'output':
      if (last && last.type === 'assistant' && !last.complete) {
        last.text += msg.data
      } else {
        messages.push({ type: 'assistant', text: msg.data, complete: false, ts: Date.now(), key: nextKey() })
      }
      return true

    case 'result':
      if (last && last.type === 'assistant' && !last.complete) {
        last.complete = true
        return true
      }
      return false

    case 'system_message':
      messages.push({ type: 'system', subtype: msg.subtype, text: msg.text, model: msg.model, key: nextKey() })
      return true

    case 'user_echo':
      messages.push({ type: 'user', text: msg.text, ts: Date.now(), key: nextKey() })
      return true

    case 'claude_started':
      // Process spawned — don't show a message yet.  The actual "Session started"
      // is shown when system_init arrives (system_message subtype=init), proving
      // the process is fully initialized and ready for input.
      return false

    case 'tool_active':
      if (last && last.type === 'tool_group') {
        last.tools.push({ name: msg.toolName, active: true })
      } else {
        messages.push({ type: 'tool_group', tools: [{ name: msg.toolName, active: true }], key: nextKey() })
      }
      return true

    case 'tool_done':
      if (last && last.type === 'tool_group') {
        for (let i = last.tools.length - 1; i >= 0; i--) {
          if (last.tools[i].name === msg.toolName && last.tools[i].active) {
            last.tools[i] = { name: msg.toolName, summary: msg.summary, active: false }
            break
          }
        }
        return true
      }
      return false

    case 'tool_output':
      messages.push({ type: 'tool_output', content: msg.content, isError: msg.isError, key: nextKey() })
      return true

    case 'image':
      messages.push({ type: 'image', base64: msg.base64, mediaType: msg.mediaType, key: nextKey() })
      return true

    case 'planning_mode':
      messages.push({ type: 'planning_mode', active: msg.active, key: nextKey() })
      return true

    default:
      return false
  }
}

/**
 * Immutable reducer: applies a single WsServerMessage to the ChatMessage array.
 * Used for real-time message processing (one event at a time).
 * Wraps applyMessageMut with defensive cloning to preserve React immutability.
 */
export function processMessage(messages: ChatMessage[], msg: WsServerMessage): ChatMessage[] {
  // Clone the array; defensively clone the last element if it could be mutated in-place
  const clone = [...messages]
  const lastIdx = clone.length - 1
  if (lastIdx >= 0) {
    const last = clone[lastIdx]
    if (last.type === 'assistant' && !last.complete) {
      clone[lastIdx] = { ...last }
    } else if (last.type === 'tool_group') {
      clone[lastIdx] = { ...last, tools: [...last.tools] }
    }
  }

  const modified = applyMessageMut(clone, msg)
  return modified ? clone : messages
}

/** Cap message list to MAX_BROWSER_MESSAGES, prepending a trim notice if truncated. */
export function trimMessages(msgs: ChatMessage[]): ChatMessage[] {
  if (msgs.length <= MAX_BROWSER_MESSAGES) return msgs
  return [
    { type: 'system', subtype: 'trim', text: 'Older messages trimmed', key: nextKey() } as ChatMessage,
    ...msgs.slice(-MAX_BROWSER_MESSAGES + 1),
  ]
}

/**
 * O(n) rebuild from history buffer — avoids O(n²) array cloning of
 * calling processMessage() in a loop. Delegates to applyMessageMut
 * which operates directly on the mutable array.
 */
export function rebuildFromHistory(buffer: WsServerMessage[]): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (const msg of buffer) {
    applyMessageMut(messages, msg)
  }
  return messages
}

export function useChatSocket({
  token,
  onSessionCreated,
  onSessionJoined,
  onSessionRenamed,
  onSessionsUpdated,
  onError,
  onRawMessage,
}: UseChatSocketOptions) {
  const callbacksRef = useRef({ onSessionCreated, onSessionJoined, onSessionRenamed, onSessionsUpdated, onError, onRawMessage })
  useEffect(() => {
    callbacksRef.current = { onSessionCreated, onSessionJoined, onSessionRenamed, onSessionsUpdated, onError, onRawMessage }
  })

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [planningMode, setPlanningMode] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [tasks, setTasks] = useState<TaskItem[]>([])
  const [currentModel, setCurrentModel] = useState<string | null>(() => localStorage.getItem('claude-model') ?? null)
  const [currentPermissionMode, setCurrentPermissionMode] = useState<PermissionMode>(() =>
    (localStorage.getItem('claude-permission-mode') as PermissionMode) || 'acceptEdits'
  )
  const [thinkingSummary, setThinkingSummary] = useState<string | null>(null)
  const promptState = usePromptState()
  const currentSessionId = useRef<string | null>(null)
  const [renderSessionId, setRenderSessionId] = useState<string | null>(null)
  const activePrompt = promptState.getActive(renderSessionId)
  const promptQueueSize = promptState.getQueueSize(renderSessionId)

  // ---------------------------------------------------------------------------
  // Streaming performance: batch consecutive text deltas and flush once per
  // animation frame. Without this, each small delta (often just a few chars)
  // triggers a full React render cycle, causing jank at high token throughput.
  // ---------------------------------------------------------------------------
  const pendingTextRef = useRef('')
  const rafRef = useRef<number | null>(null)

  const flushPendingText = useCallback(() => {
    rafRef.current = null
    const text = pendingTextRef.current
    if (!text) return
    pendingTextRef.current = ''
    setMessages(prev => {
      const last = prev[prev.length - 1]
      if (last && last.type === 'assistant' && !last.complete) {
        const updated = [...prev]
        updated[updated.length - 1] = { ...last, text: last.text + text }
        return trimMessages(updated)
      }
      return trimMessages([...prev, { type: 'assistant', text, complete: false, ts: Date.now(), key: nextKey() }])
    })
  }, [])

  const flushBeforeStructuralMessage = useCallback(() => {
    if (pendingTextRef.current) {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      flushPendingText()
    }
  }, [flushPendingText])

  // ---------------------------------------------------------------------------
  // Message handler — processes all WsServerMessage types from the connection
  // ---------------------------------------------------------------------------
  const handleMessage = useCallback((msg: WsServerMessage) => {
    callbacksRef.current.onRawMessage?.(msg)
    switch (msg.type) {
      case 'thinking':
        setThinkingSummary(msg.summary)
        setIsProcessing(true)
        break

      case 'output': {
        setThinkingSummary(null)
        setIsProcessing(true)
        pendingTextRef.current += msg.data
        if (!rafRef.current) {
          rafRef.current = requestAnimationFrame(flushPendingText)
        }
        break
      }

      case 'result':
        setIsProcessing(false)
        setThinkingSummary(null)
        flushBeforeStructuralMessage()
        setMessages(prev => trimMessages(processMessage(prev, msg)))
        break

      case 'system_message':
        if (msg.subtype === 'init' && msg.model) {
          setCurrentModel(msg.model)
          localStorage.setItem('claude-model', msg.model)
        }
        flushBeforeStructuralMessage()
        setMessages(prev => trimMessages(processMessage(prev, msg)))
        break

      case 'user_echo':
        flushBeforeStructuralMessage()
        setMessages(prev => trimMessages(processMessage(prev, msg)))
        break

      case 'tool_active':
        setThinkingSummary(null)
        setIsProcessing(true)
        flushBeforeStructuralMessage()
        setMessages(prev => trimMessages(processMessage(prev, msg)))
        break

      case 'tool_done':
        flushBeforeStructuralMessage()
        setMessages(prev => trimMessages(processMessage(prev, msg)))
        break

      case 'tool_output':
        flushBeforeStructuralMessage()
        setMessages(prev => trimMessages(processMessage(prev, msg)))
        break

      case 'image':
        flushBeforeStructuralMessage()
        setMessages(prev => trimMessages(processMessage(prev, msg)))
        break

      case 'planning_mode':
        setPlanningMode(msg.active)
        setMessages(prev => trimMessages(processMessage(prev, msg)))
        break

      case 'todo_update':
        setTasks(msg.tasks)
        break

      // Prompt handling: permission requests and questions from Claude's control protocol.
      // See server/types.ts:ClaudeControlRequest — prompt responses require a control_response
      // wrapper sent via the 'prompt_response' WsClientMessage type, not a regular 'input' message.
      case 'prompt': {
        const sid = msg.sessionId ?? currentSessionId.current
        if (!sid) break
        promptState.enqueue(msg, sid)
        if (sid === currentSessionId.current) {
          setIsProcessing(false)
          setThinkingSummary(null)
        }
        break
      }

      case 'prompt_dismiss': {
        promptState.dismiss(msg.requestId)
        break
      }

      case 'session_created':
        currentSessionId.current = msg.sessionId
        setRenderSessionId(msg.sessionId)
        setMessages([])
        setTasks([])
        setIsProcessing(false)
        setThinkingSummary(null)
        callbacksRef.current.onSessionCreated?.(msg.sessionId)
        break

      case 'session_joined': {
        currentSessionId.current = msg.sessionId
        setRenderSessionId(msg.sessionId)
        setIsProcessing(false)
        setThinkingSummary(null)
        // Sync model and permission mode from server state
        if (msg.model) {
          setCurrentModel(msg.model)
          localStorage.setItem('claude-model', msg.model)
        }
        if (msg.permissionMode) {
          setCurrentPermissionMode(msg.permissionMode)
          localStorage.setItem('claude-permission-mode', msg.permissionMode)
        }
        let rebuilt: ChatMessage[] = []
        let restoredPlanMode = false
        let restoredTasks: TaskItem[] = []
        if (msg.outputBuffer?.length) {
          rebuilt = rebuildFromHistory(msg.outputBuffer)
          for (const bufferedMsg of msg.outputBuffer) {
            if (bufferedMsg.type === 'planning_mode') {
              restoredPlanMode = bufferedMsg.active
            }
            if (bufferedMsg.type === 'todo_update') {
              restoredTasks = bufferedMsg.tasks
            }
          }
        }
        setPlanningMode(restoredPlanMode)
        setTasks(restoredTasks)
        setMessages(trimMessages(rebuilt))
        callbacksRef.current.onSessionJoined?.(msg.sessionId)
        break
      }

      case 'claude_started':
        setMessages(prev => trimMessages(processMessage(prev, msg)))
        break

      case 'claude_stopped':
      case 'exit': {
        setIsProcessing(false)
        setThinkingSummary(null)
        const sid = currentSessionId.current
        if (sid) promptState.clearForSession(sid)
        break
      }

      case 'error':
        callbacksRef.current.onError?.(msg.message)
        break

      case 'session_deleted':
        setMessages(prev => trimMessages([...prev, { type: 'system', subtype: 'error', text: 'Session was deleted', key: nextKey() }]))
        break

      case 'connected':
      case 'pong':
        break

      case 'session_name_update':
        callbacksRef.current.onSessionRenamed?.(msg.sessionId, msg.name)
        break

      case 'sessions_updated':
        callbacksRef.current.onSessionsUpdated?.()
        break

      case 'worktree_created':
        // Trigger a sessions refresh so sidebar picks up the new worktreePath
        callbacksRef.current.onSessionsUpdated?.()
        break

      case 'info':
        break

    }
  }, [flushPendingText, flushBeforeStructuralMessage, promptState])

  const handleMessageRef = useRef(handleMessage)
  useEffect(() => { handleMessageRef.current = handleMessage }, [handleMessage])

  // ---------------------------------------------------------------------------
  // Connection layer — delegates transport to useWsConnection
  // ---------------------------------------------------------------------------
  const onDisconnect = useCallback(() => {
    setIsProcessing(false)
    setThinkingSummary(null)
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  const onHealthPong = useCallback((sendFn: (msg: WsClientMessage) => void) => {
    const sid = currentSessionId.current
    if (sid) sendFn({ type: 'join_session', sessionId: sid })
  }, [])

  const { connState, send, disconnect, restoreSession, reconnect } = useWsConnection({
    token,
    onMessageRef: handleMessageRef,
    onDisconnect,
    onHealthPong,
  })

  // ---------------------------------------------------------------------------
  // Session-level operations
  // ---------------------------------------------------------------------------
  const joinSession = useCallback((sessionId: string) => {
    send({ type: 'join_session', sessionId })
  }, [send])

  const createSession = useCallback((name: string, workingDir: string, useWorktree?: boolean, permissionMode?: PermissionMode, provider?: import('../types').CodingProvider) => {
    send({ type: 'create_session', name, workingDir, useWorktree, permissionMode, provider })
  }, [send])

  const sendInput = useCallback((data: string, displayText?: string) => {
    send({ type: 'input', data, ...(displayText ? { displayText } : {}) } as WsClientMessage)
    setIsProcessing(true)
    const sid = currentSessionId.current
    if (sid) promptState.clearForSession(sid)
  }, [send, promptState])

  const sendPromptResponse = useCallback((value: string | string[]) => {
    const requestId = activePrompt?.requestId
    send({ type: 'prompt_response', value, requestId } as WsClientMessage)
    if (requestId) promptState.dismiss(requestId)
    setIsProcessing(true)
  }, [send, activePrompt?.requestId, promptState])

  const leaveSession = useCallback(() => {
    send({ type: 'leave_session' })
    currentSessionId.current = null
    setRenderSessionId(null)
    setIsProcessing(false)
    setThinkingSummary(null)
    // No prompt clearing — prompts are session-scoped and persist for when user returns
  }, [send])

  const clearMessages = useCallback(() => {
    setMessages([])
  }, [])

  /** Push a local-only system message (e.g. for built-in command feedback). */
  const addSystemMessage = useCallback((text: string, subtype: 'notification' | 'init' | 'error' = 'notification') => {
    setMessages(prev => trimMessages([...prev, { type: 'system', subtype, text, key: nextKey() }]))
  }, [])

  const setModel = useCallback((model: string) => {
    send({ type: 'set_model', model })
    setCurrentModel(model)
    localStorage.setItem('claude-model', model)
  }, [send])

  const moveToWorktree = useCallback(() => {
    send({ type: 'move_to_worktree' })
  }, [send])

  const setPermissionMode = useCallback((mode: PermissionMode) => {
    send({ type: 'set_permission_mode', permissionMode: mode })
    setCurrentPermissionMode(mode)
    localStorage.setItem('claude-permission-mode', mode)
  }, [send])

  return {
    connState,
    messages,
    tasks,
    planningMode,
    isProcessing,
    thinkingSummary,
    waitingSessions: promptState.waitingSessions,
    activePrompt,
    promptQueueSize,
    currentModel,
    send,
    joinSession,
    createSession,
    sendInput,
    sendPromptResponse,
    leaveSession,
    clearMessages,
    addSystemMessage,
    disconnect,
    reconnect,
    restoreSession,
    setModel,
    currentPermissionMode,
    setPermissionMode,
    moveToWorktree,
  }
}
