/**
 * Encapsulates message sending, file uploads, skill expansion,
 * tentative queue management, and docs context injection.
 *
 * Extracted from App.tsx to reduce its complexity and colocate
 * all message-send logic in one place.
 */

import { useState, useCallback, useEffect, useMemo } from 'react'
import type { ChatMessage, Session, Skill } from '../types'
import type { QueueEntry } from './useTentativeQueue'
import { groupKey } from './useSessionOrchestration'
import { uploadAndBuildMessage } from '../lib/ccApi'
import { resolveBuiltinAlias, BUNDLED_SKILLS } from '../lib/slashCommands'

/** Set of bundled skill command names for fast lookup. */
const BUNDLED_COMMANDS = new Set(BUNDLED_SKILLS.map(s => s.command))

interface UseSendMessageOptions {
  token: string
  activeSessionId: string | null
  activeWorkingDir: string | null
  sessions: Session[]
  allSkills: Skill[]
  sendInput: (data: string, displayText?: string) => void
  onBuiltinCommand: (command: string, args: string) => void
  tentativeQueues: Record<string, QueueEntry[]>
  addToQueue: (sessionId: string, text: string, files?: File[]) => void
  clearQueue: (sessionId: string) => void
  docsContext: { isOpen: boolean; selectedFile: string | null; repoWorkingDir: string | null }
}

export function useSendMessage({
  token,
  activeSessionId,
  activeWorkingDir,
  sessions,
  allSkills,
  sendInput,
  onBuiltinCommand,
  tentativeQueues,
  addToQueue,
  clearQueue,
  docsContext,
}: UseSendMessageOptions) {
  const [uploadStatus, setUploadStatus] = useState<string | null>(null)
  const [sessionPendingFiles, setSessionPendingFiles] = useState<Record<string, File[]>>({})

  const pendingFiles = useMemo(
    () => (activeSessionId ? (sessionPendingFiles[activeSessionId] ?? []) : []),
    [activeSessionId, sessionPendingFiles],
  )

  const addFiles = useCallback((files: File[]) => {
    if (!activeSessionId) return
    setSessionPendingFiles(prev => ({
      ...prev,
      [activeSessionId]: [...(prev[activeSessionId] ?? []), ...files],
    }))
  }, [activeSessionId])

  const removeFile = useCallback((index: number) => {
    if (!activeSessionId) return
    setSessionPendingFiles(prev => ({
      ...prev,
      [activeSessionId]: (prev[activeSessionId] ?? []).filter((_, i) => i !== index),
    }))
  }, [activeSessionId])

  /**
   * Expand a slash command to its full prompt content.
   *
   * Returns `{ expanded, displayText, handled }`:
   * - `handled = true` means the command was a built-in (executed via
   *   onBuiltinCommand) and nothing further should be sent.
   * - Otherwise `expanded` is the text to send to Claude.
   */
  const processSlashCommand = useCallback((text: string): { expanded: string; displayText?: string; handled: boolean } => {
    const trimmed = text.trim()
    if (!trimmed.startsWith('/')) return { expanded: text, handled: false }

    const spaceIdx = trimmed.indexOf(' ')
    const command = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)
    const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim()

    // 1. Built-in commands — handled locally by Codekin, not sent to Claude
    const canonical = resolveBuiltinAlias(command)
    if (canonical) {
      onBuiltinCommand(canonical, args)
      return { expanded: text, handled: true }
    }

    // 2. Filesystem skills — expand content client-side
    const skill = allSkills.find(s => s.command === command)
    if (skill?.content) {
      const content = skill.content.replace(/\$ARGUMENTS/g, args || '(no arguments provided)')
      const parts = [`[Skill: ${skill.name}]`, '', content]
      if (args) parts.push('', `User instructions: ${args}`)
      return { expanded: parts.join('\n'), displayText: text, handled: false }
    }

    // 3. Bundled skills — send as-is so Claude's Skill tool handles them
    if (BUNDLED_COMMANDS.has(command)) {
      return { expanded: text, displayText: text, handled: false }
    }

    // Unknown slash command — pass through as regular text
    return { expanded: text, handled: false }
  }, [allSkills, onBuiltinCommand])

  const handleSend = useCallback(async (text: string) => {
    if (!token) return
    const { expanded, displayText, handled } = processSlashCommand(text)
    if (handled) return

    // Include docs context if viewing a doc
    const docsPrefix = docsContext.isOpen && docsContext.selectedFile && docsContext.repoWorkingDir
      ? `[Viewing doc: ${docsContext.selectedFile} in ${docsContext.repoWorkingDir}]\n\n`
      : ''

    // Tentative mode: hold message if another session for the same repo is processing,
    // or if this session already has queued messages
    const isAlreadyTentative = (tentativeQueues[activeSessionId ?? '']?.length ?? 0) > 0
    const hasConflict = !!activeWorkingDir &&
      sessions.some(s => groupKey(s) === activeWorkingDir && s.isProcessing && s.id !== activeSessionId)
    if (activeSessionId && (isAlreadyTentative || hasConflict)) {
      if (pendingFiles.length > 0) {
        setSessionPendingFiles(prev => ({ ...prev, [activeSessionId]: [] }))
        setUploadStatus('Uploading files...')
        try {
          const message = await uploadAndBuildMessage(token, pendingFiles, docsPrefix + expanded)
          addToQueue(activeSessionId, message)
          setUploadStatus(null)
        } catch (err) {
          // Upload failed — queue text only so the message isn't lost
          addToQueue(activeSessionId, docsPrefix + expanded)
          setUploadStatus(`Upload failed: ${err instanceof Error ? err.message : 'unknown error'}`)
          setTimeout(() => setUploadStatus(null), 3000)
        }
      } else {
        addToQueue(activeSessionId, docsPrefix + expanded)
      }
      return
    }

    const files = pendingFiles
    if (files.length === 0) {
      sendInput(docsPrefix + expanded, displayText)
      return
    }
    setUploadStatus('Uploading files...')
    try {
      const message = await uploadAndBuildMessage(token, files, docsPrefix + expanded)
      if (activeSessionId) setSessionPendingFiles(prev => ({ ...prev, [activeSessionId]: [] }))
      setUploadStatus(null)
      sendInput(message)
    } catch (err) {
      setUploadStatus(`Upload failed: ${err instanceof Error ? err.message : 'unknown error'}`)
      setTimeout(() => setUploadStatus(null), 3000)
    }
  }, [token, activeSessionId, activeWorkingDir, sessions, tentativeQueues, addToQueue, pendingFiles, processSlashCommand, sendInput, docsContext.isOpen, docsContext.selectedFile, docsContext.repoWorkingDir])

  const handleExecuteTentative = useCallback(async (sessionId: string) => {
    const queue = tentativeQueues[sessionId] ?? []
    clearQueue(sessionId)
    for (let i = 0; i < queue.length; i++) {
      const entry = queue[i]
      if (i > 0) await new Promise(r => setTimeout(r, 100))
      if (entry.files.length > 0 && token) {
        try {
          const message = await uploadAndBuildMessage(token, entry.files, entry.text)
          sendInput(message)
        } catch {
          sendInput(entry.text)
        }
      } else {
        sendInput(entry.text)
      }
    }
  }, [tentativeQueues, clearQueue, sendInput, token])

  const handleDiscardTentative = useCallback((sessionId: string) => {
    clearQueue(sessionId)
  }, [clearQueue])

  // Auto-execute tentative queue when the blocking session(s) finish
  useEffect(() => {
    for (const [sessionId, queue] of Object.entries(tentativeQueues)) {
      if (queue.length === 0) continue
      const session = sessions.find(s => s.id === sessionId)
      if (!session) continue
      const wDir = groupKey(session)
      const blocking = sessions.filter(s => groupKey(s) === wDir && s.isProcessing && s.id !== sessionId)
      if (blocking.length === 0 && sessionId === activeSessionId) {
        void handleExecuteTentative(sessionId)
        setTimeout(() => {
          setUploadStatus('Session finished — starting queued session.')
          setTimeout(() => setUploadStatus(null), 3000)
        }, 0)
      }
    }
  }, [sessions]) // eslint-disable-line react-hooks/exhaustive-deps

  // Tentative messages for display in ChatView
  const tentativeMessages: ChatMessage[] = activeSessionId
    ? (tentativeQueues[activeSessionId] ?? []).map((entry, index) => ({
        type: 'tentative' as const,
        text: entry.files.length > 0
          ? `${entry.text}\n📎 ${entry.files.length} file${entry.files.length > 1 ? 's' : ''} attached`
          : entry.text,
        index,
        key: `tentative-${index}`,
      }))
    : []

  const activeTentativeCount = activeSessionId ? (tentativeQueues[activeSessionId]?.length ?? 0) : 0

  return {
    handleSend,
    handleExecuteTentative,
    handleDiscardTentative,
    tentativeMessages,
    activeTentativeCount,
    pendingFiles,
    addFiles,
    removeFile,
    uploadStatus,
  }
}
