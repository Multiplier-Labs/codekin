/**
 * Right sidebar panel showing all file changes for the current session.
 * Manages open/close state, resizable width, and renders the diff viewer.
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import { IconX, IconFileCode } from '@tabler/icons-react'
import type { DiffFileStatus, WsClientMessage, WsServerMessage } from '../types'
import { useDiff } from '../hooks/useDiff'
import { DiffToolbar } from './diff/DiffToolbar'
import { DiffFileTree } from './diff/DiffFileTree'
import { DiffFileCard } from './diff/DiffFileCard'

const MIN_WIDTH = 280
const MAX_WIDTH = 1200
const DEFAULT_WIDTH = 400
const STORAGE_KEY = 'codekin-diff-panel-width'

interface DiffPanelProps {
  isOpen: boolean
  onClose: () => void
  send: (msg: WsClientMessage) => void
  /** Register callback so parent can forward diff_result/diff_error messages. */
  onHandleMessage: (fn: (msg: WsServerMessage) => void) => void
  /** Register callback so parent can forward tool_done events. */
  onHandleToolDone: (fn: (toolName: string, summary?: string) => void) => void
}

export function DiffPanel({ isOpen, onClose, send, onHandleMessage, onHandleToolDone }: DiffPanelProps) {
  const [width, setWidth] = useState(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Number(stored))) : DEFAULT_WIDTH
  })

  const diff = useDiff({ send, isOpen })
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-arguments -- new Map() infers Map<any,any>
  const fileRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const dragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  // Register message forwarding callbacks with parent
  useEffect(() => {
    onHandleMessage(diff.handleMessage)
  }, [diff.handleMessage, onHandleMessage])

  useEffect(() => {
    onHandleToolDone(diff.handleToolDone)
  }, [diff.handleToolDone, onHandleToolDone])

  // Persist width
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(width))
  }, [width])

  // Resize drag handler
  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    startX.current = e.clientX
    startWidth.current = width

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      // Dragging left edge means decreasing clientX = increasing width
      const delta = startX.current - ev.clientX
      setWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth.current + delta)))
    }
    const onMouseUp = () => {
      dragging.current = false
      document.body.style.cursor = ''
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
    document.body.style.cursor = 'col-resize'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [width])

  const handleSelectFile = useCallback((path: string) => {
    setActiveFile(path)
    const el = fileRefs.current.get(path)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [])

  const handleDiscard = useCallback((path: string, status: DiffFileStatus) => {
    diff.discard([path], { [path]: status })
  }, [diff])

  const handleDiscardAll = useCallback(() => {
    diff.discard()
  }, [diff])

  // Keyboard shortcut: Escape to close
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => { document.removeEventListener('keydown', handler); }
  }, [isOpen, onClose])

  if (!isOpen) return null

  const hasUntrackedFiles = diff.files.some(f => f.status === 'added')

  return (
    <div
      className="relative flex flex-col h-full bg-neutral-12 border-l border-neutral-9 overflow-hidden transition-[width] duration-150"
      style={{ width, minWidth: MIN_WIDTH, maxWidth: MAX_WIDTH }}
    >
      {/* Resize handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary-6/40 z-20"
        onMouseDown={onDragStart}
      />

      {/* Panel header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-9 shrink-0">
        <div className="flex items-center gap-2">
          {diff.summary.filesChanged > 0 && (
            <span className="w-2 h-2 rounded-full bg-success-5" />
          )}
          <span className="text-sm font-medium text-neutral-2">Changes</span>
        </div>
        <button
          className="p-1 rounded hover:bg-neutral-9 text-neutral-4 hover:text-neutral-2"
          onClick={onClose}
          title="Close diff panel"
        >
          <IconX size={14} />
        </button>
      </div>

      {/* Toolbar */}
      <DiffToolbar
        branch={diff.branch}
        scope={diff.scope}
        summary={diff.summary}
        loading={diff.loading}
        hasUntrackedFiles={hasUntrackedFiles}
        onScopeChange={diff.changeScope}
        onRefresh={diff.refresh}
        onDiscardAll={handleDiscardAll}
      />

      {/* Error state */}
      {diff.error && (
        <div className="px-3 py-2 text-xs text-error-5 bg-error-950/20">
          {diff.error}
        </div>
      )}

      {/* Scrollable content area (file tree + file cards) */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {/* File tree */}
        {diff.files.length > 0 && (
          <div className="border-b border-neutral-9">
            <DiffFileTree
              files={diff.files}
              activeFile={activeFile}
              onSelectFile={handleSelectFile}
            />
          </div>
        )}

        {/* File cards */}
        <div className="px-2 py-2 flex flex-col gap-2">
          {diff.files.length === 0 && !diff.loading && !diff.error && (
            <div className="flex flex-col items-center justify-center py-8 text-neutral-6">
              <IconFileCode size={32} className="mb-2 opacity-50" />
              <span className="text-xs">No changes detected</span>
            </div>
          )}

          {diff.summary.truncated && (
            <div className="px-3 py-2 text-xs text-warning-5 bg-warning-950/20 rounded">
              Diff truncated — showing partial results
            </div>
          )}

          {diff.files.map(file => (
            <DiffFileCard
              key={file.path}
              file={file}
              isActive={file.path === activeFile}
              onDiscard={handleDiscard}
              onScrollRef={(el) => {
                if (el) fileRefs.current.set(file.path, el)
                else fileRefs.current.delete(file.path)
              }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
