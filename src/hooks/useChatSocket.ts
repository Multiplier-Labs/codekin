/**
 * Core WebSocket hook for Codekin chat sessions.
 *
 * Manages the full lifecycle: connection with auto-reconnect (exponential backoff),
 * session join/leave/create, sending user input and prompt responses, and
 * converting raw WsServerMessage events into ChatMessage[] for the UI.
 *
 * Text streaming is batched via requestAnimationFrame for ~60fps rendering
 * without flooding React state updates on every small text delta.
 */

import { useRef, useCallback, useEffect, useState } from 'react'
import type { WsClientMessage, WsServerMessage, ConnectionState, ChatMessage, TaskItem } from '../types'
import { wsUrl, checkAuthSession, redirectToLogin } from '../lib/ccApi'
import { usePromptState } from './usePromptState'

/** Max chat messages kept in the browser before trimming older entries. */
const MAX_BROWSER_MESSAGES = 500

/** How often to check whether the Authelia session is still valid (ms). */
const AUTH_CHECK_INTERVAL_MS = 60_000

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
      messages.push({ type: 'system', subtype: 'init', text: 'Session started', key: nextKey() })
      return true

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
}: UseChatSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null)
  const callbacksRef = useRef({ onSessionCreated, onSessionJoined, onSessionRenamed, onSessionsUpdated, onError })
  useEffect(() => {
    callbacksRef.current = { onSessionCreated, onSessionJoined, onSessionRenamed, onSessionsUpdated, onError }
  })
  const [connState, setConnState] = useState<ConnectionState>('disconnected')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [planningMode, setPlanningMode] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [tasks, setTasks] = useState<TaskItem[]>([])

  const [currentModel, setCurrentModel] = useState<string | null>(() => localStorage.getItem('claude-model') ?? null)


  const [thinkingSummary, setThinkingSummary] = useState<string | null>(null)
  const [waitingSessions, setWaitingSessions] = useState<Record<string, boolean>>({})
  const { state: promptState, clear: clearPromptState, setFromMessage: setPromptFromMessage } = usePromptState()
  const currentSessionId = useRef<string | null>(null)

  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pingTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const backoff = useRef(1000)
  const intentionalClose = useRef(false)
  /** Stable ref to `connect` for self-referential reconnection in ws.onclose. */
  const connectRef = useRef<() => void>(() => {})

  // Session restore on visibility change
  const restoringRef = useRef(false)
  const awaitingHealthPong = useRef(false)
  const healthPongTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Streaming performance: batch consecutive text deltas and flush once per
  // animation frame. Without this, each small delta (often just a few chars)
  // triggers a full React render cycle, causing jank at high token throughput.
  //
  // Ordering invariant: pendingTextRef must be flushed to the message list
  // *before* any non-output structural message (result, tool_active, tool_done,
  // tool_output, system_message, user_echo) is appended.  This preserves the
  // correct stream order — text that arrived before a tool call must appear
  // before the tool group in the rendered UI.  Every case below that handles a
  // structural message therefore starts with the same flush-if-pending guard.
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

  /**
   * Flush any buffered text delta to the message list before appending a
   * structural message (result, tool_active, tool_done, tool_output,
   * system_message, user_echo). Preserves stream ordering: text that
   * arrived before the structural event must appear before it in the UI.
   */
  const flushBeforeStructuralMessage = useCallback(() => {
    if (pendingTextRef.current) {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      flushPendingText()
    }
  }, [flushPendingText])

  const cleanup = useCallback(() => {
    if (pingTimer.current) {
      clearInterval(pingTimer.current)
      pingTimer.current = null
    }
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current)
      reconnectTimer.current = null
    }
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (healthPongTimer.current) {
      clearTimeout(healthPongTimer.current)
      healthPongTimer.current = null
    }
  }, [])

  const send = useCallback((msg: WsClientMessage) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }, [])

  const connect = useCallback(() => {
    if (!token) return
    cleanup()
    setConnState('connecting')

    const ws = new WebSocket(wsUrl())
    wsRef.current = ws

    ws.onopen = () => {
      // Send auth token as first message (not in URL to avoid log exposure)
      ws.send(JSON.stringify({ type: 'auth', token }))
      setConnState('connected')
      backoff.current = 1000
      pingTimer.current = setInterval(() => {
        send({ type: 'ping' })
      }, 30000)
    }

    ws.onmessage = (event) => {
      let msg: WsServerMessage
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }

      switch (msg.type) {
        case 'thinking':
          setThinkingSummary(msg.summary)
          setIsProcessing(true)
          break

        case 'output': {
          setThinkingSummary(null)
          setIsProcessing(true)
          // Batch text deltas for ~60fps rendering
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

        case 'planning_mode':
          setPlanningMode(msg.active)
          setMessages(prev => trimMessages(processMessage(prev, msg)))
          break

        case 'todo_update':
          setTasks(msg.tasks)
          break

        case 'prompt': {
          // Check if this prompt is for a different session (global broadcast notification)
          const promptSessionId = msg.sessionId
          if (promptSessionId && promptSessionId !== currentSessionId.current) {
            // Cross-session approval needed — update waiting indicator only
            setWaitingSessions(prev => ({ ...prev, [promptSessionId]: true }))
            break
          }

          // This prompt is for our session — show PromptButtons
          setIsProcessing(false)
          setThinkingSummary(null)
          const sid = currentSessionId.current
          if (sid) {
            setWaitingSessions(prev => ({ ...prev, [sid]: true }))
          }
          setPromptFromMessage(msg)
          break
        }

        case 'prompt_dismiss':
          clearPromptState()
          break

        case 'session_created':
          currentSessionId.current = msg.sessionId
          setMessages([])
          setTasks([])
          setIsProcessing(false)
          setThinkingSummary(null)
          callbacksRef.current.onSessionCreated?.(msg.sessionId)
          break

        case 'session_joined': {
          currentSessionId.current = msg.sessionId
          setIsProcessing(false)
          setThinkingSummary(null)
          // Rebuild messages from output buffer (O(n) mutable builder)
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
          if (sid) {
            setWaitingSessions(prev => prev[sid] ? { ...prev, [sid]: false } : prev)
          }
          clearPromptState()
          break
        }

        case 'error':
          callbacksRef.current.onError?.(msg.message)
          break

        case 'session_deleted':
          setMessages(prev => trimMessages([...prev, { type: 'system', subtype: 'error', text: 'Session was deleted', key: nextKey() }]))
          break

        case 'connected':
          // No-op in chat mode — system_message from Claude init handles this
          break

        case 'pong':
          if (awaitingHealthPong.current) {
            awaitingHealthPong.current = false
            if (healthPongTimer.current) {
              clearTimeout(healthPongTimer.current)
              healthPongTimer.current = null
            }
            // WS is alive — re-join session for fresh state
            const sid = currentSessionId.current
            if (sid) {
              send({ type: 'join_session', sessionId: sid })
            }
          }
          break
        case 'session_name_update':
          callbacksRef.current.onSessionRenamed?.(msg.sessionId, msg.name)
          break

        case 'sessions_updated':
          // Clear stale cross-session waiting indicators. Cross-session prompt entries
          // are set when a prompt arrives for another session, but prompt_dismiss is only
          // broadcast to that session's clients so we never receive it here. Clearing on
          // sessions_updated is safe: it fires when isProcessing changes, which only
          // happens after the prompt is resolved and the session resumes/finishes.
          setWaitingSessions(prev => {
            const sid = currentSessionId.current
            const hasCrossSession = Object.entries(prev).some(([k, v]) => k !== sid && v)
            if (!hasCrossSession) return prev
            const next: Record<string, boolean> = {}
            if (sid && prev[sid]) next[sid] = true
            return next
          })
          callbacksRef.current.onSessionsUpdated?.()
          break

        case 'info':
        case 'usage_update':
          break
      }
    }

    ws.onclose = (event) => {
      setConnState('disconnected')
      setIsProcessing(false)
      setThinkingSummary(null)
      cleanup()
      wsRef.current = null

      // WebSocket closed with 4001 = auth failure from our server
      if (event.code === 4001) {
        redirectToLogin()
        return
      }

      if (!intentionalClose.current) {
        // Before reconnecting, check if the Authelia session is still valid.
        // If it expired, redirect to login instead of reconnecting endlessly.
        checkAuthSession().then(valid => {
          if (!valid) {
            redirectToLogin()
            return
          }
          reconnectTimer.current = setTimeout(() => {
            backoff.current = Math.min(backoff.current * 2, 30000)
            connectRef.current()
          }, backoff.current)
        })
      }
    }

    ws.onerror = () => {
      // onclose will fire after this
    }
  }, [token, cleanup, send, flushPendingText, flushBeforeStructuralMessage, clearPromptState, setPromptFromMessage])
  useEffect(() => { connectRef.current = connect }, [connect])

  const disconnect = useCallback(() => {
    intentionalClose.current = true
    cleanup()
    wsRef.current?.close()
    wsRef.current = null
    setConnState('disconnected')
  }, [cleanup])

  const joinSession = useCallback((sessionId: string) => {
    send({ type: 'join_session', sessionId })
  }, [send])

  const createSession = useCallback((name: string, workingDir: string) => {
    send({ type: 'create_session', name, workingDir })
  }, [send])

  const sendInput = useCallback((data: string, displayText?: string) => {
    send({ type: 'input', data, ...(displayText ? { displayText } : {}) })
    setIsProcessing(true)
    const sid = currentSessionId.current
    if (sid) {
      setWaitingSessions(prev => prev[sid] ? { ...prev, [sid]: false } : prev)
    }
    clearPromptState()
  }, [send, clearPromptState])

  const sendPromptResponse = useCallback((value: string | string[]) => {
    send({ type: 'prompt_response', value, requestId: promptState.promptRequestId ?? undefined })
    setIsProcessing(true)
    const sid = currentSessionId.current
    if (sid) {
      setWaitingSessions(prev => prev[sid] ? { ...prev, [sid]: false } : prev)
    }
    clearPromptState()
  }, [send, promptState.promptRequestId, clearPromptState])

  const leaveSession = useCallback(() => {
    send({ type: 'leave_session' })
    currentSessionId.current = null
    setIsProcessing(false)
    setThinkingSummary(null)
  }, [send])

  /**
   * Restore the current session after a visibility change (tab focus return).
   * Handles three cases: WS open (ping to verify, rejoin on pong), WS connecting
   * (let existing onopen handle it), WS closed (reconnect immediately).
   */
  const restoreSession = useCallback(() => {
    // Guard against rapid concurrent restore attempts
    if (restoringRef.current) return
    restoringRef.current = true
    setTimeout(() => { restoringRef.current = false }, 3000)

    const ws = wsRef.current

    // Case 1: WS appears open — probe with ping, rejoin on pong
    if (ws && ws.readyState === WebSocket.OPEN) {
      awaitingHealthPong.current = true
      healthPongTimer.current = setTimeout(() => {
        // No pong in 2s — zombie connection, force close
        awaitingHealthPong.current = false
        healthPongTimer.current = null
        backoff.current = 1000
        ws.close()
      }, 2000)
      send({ type: 'ping' })
      return
    }

    // Case 2: WS is connecting — let existing onopen + autoJoin handle it
    if (ws && ws.readyState === WebSocket.CONNECTING) {
      return
    }

    // Case 3: WS is closed/null — check auth before reconnecting
    checkAuthSession().then(valid => {
      if (!valid) {
        redirectToLogin()
        return
      }
      backoff.current = 1000
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current)
        reconnectTimer.current = null
      }
      connect()
    })
  }, [send, connect])

  const clearMessages = useCallback(() => {
    setMessages([])
  }, [])

  // Connect on mount when token available, disconnect on unmount
  useEffect(() => {
    if (token) {
      intentionalClose.current = false
      // eslint-disable-next-line react-hooks/set-state-in-effect -- WebSocket connect legitimately sets connState
      connect()
    }
    return () => {
      disconnect()
    }
  }, [token]) // eslint-disable-line react-hooks/exhaustive-deps

  // Periodic Authelia session check — detect expiry while the tab is open
  useEffect(() => {
    if (!token) return
    const id = setInterval(async () => {
      const valid = await checkAuthSession()
      if (!valid) redirectToLogin()
    }, AUTH_CHECK_INTERVAL_MS)
    return () => clearInterval(id)
  }, [token])

  const setModel = useCallback((model: string) => {
    send({ type: 'set_model', model })
    setCurrentModel(model)
    localStorage.setItem('claude-model', model)
  }, [send])

  return {
    connState,
    messages,
    tasks,
    planningMode,
    isProcessing,
    thinkingSummary,
    waitingSessions,
    promptOptions: promptState.promptOptions,
    promptQuestion: promptState.promptQuestion,
    promptType: promptState.promptType,
    promptQuestions: promptState.promptQuestions,
    approvePattern: promptState.approvePattern,
    multiSelect: promptState.multiSelect,
    currentModel,
    send,
    joinSession,
    createSession,
    sendInput,
    sendPromptResponse,
    leaveSession,
    clearMessages,
    disconnect,
    reconnect: connect,
    restoreSession,
    setModel,
  }
}
