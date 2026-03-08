/**
 * Chat input bar with textarea, file attachment, and skill menu.
 *
 * Supports Enter to send, Shift+Enter for newline, Ctrl+C to interrupt,
 * Escape to blur. Height is user-draggable via a top handle and persisted
 * to localStorage.
 */

import { useState, useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react'
import { IconSend, IconPaperclip, IconX, IconTerminal2, IconChevronDown } from '@tabler/icons-react'
import { SkillMenu, type SkillGroup } from './SkillMenu'
import { DropZone } from './DropZone'

const MODELS = [
  { id: 'claude-opus-4-6', label: 'Opus 4.6' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
]

function shortModelLabel(modelId: string): string {
  return MODELS.find(m => m.id === modelId)?.label ?? modelId.replace(/^claude-/, '')
}

const INPUT_HEIGHT_KEY = 'inputBarHeight'
const DEFAULT_HEIGHT = 120
const MIN_HEIGHT = 60
const MAX_HEIGHT = 600

/** Imperative handle for programmatic text insertion (e.g. from skill menu). */
export interface InputBarHandle {
  insertText: (text: string) => void
}

interface InputBarProps {
  onSendInput: (data: string) => void
  /** True when Claude is waiting for user input (prompt mode). */
  isWaiting: boolean
  disabled: boolean
  onEscape: () => void
  pendingFiles: File[]
  onAddFiles: (files: File[]) => void
  onRemoveFile: (index: number) => void
  skillGroups?: SkillGroup[]
  initialValue?: string
  onValueChange?: (value: string) => void
  currentModel?: string | null
  onModelChange?: (model: string) => void
}

export const InputBar = forwardRef<InputBarHandle, InputBarProps>(function InputBar({ onSendInput, isWaiting, disabled, onEscape, pendingFiles, onAddFiles, onRemoveFile, skillGroups, initialValue = '', onValueChange, currentModel, onModelChange }, ref) {
  const [value, setValue] = useState(initialValue)
  const [skillMenuOpen, setSkillMenuOpen] = useState(false)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [height, setHeight] = useState(() => {
    const stored = localStorage.getItem(INPUT_HEIGHT_KEY)
    return stored ? Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, parseInt(stored, 10))) : DEFAULT_HEIGHT
  })
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const prevWaiting = useRef(false)
  const heightRef = useRef(height)

  useImperativeHandle(ref, () => ({
    insertText(text: string) {
      setValue(text)
      setTimeout(() => textareaRef.current?.focus(), 0)
    },
  }))

  // Auto-focus on waiting transition false → true
  useEffect(() => {
    if (isWaiting && !prevWaiting.current) {
      textareaRef.current?.focus()
    }
    prevWaiting.current = isWaiting
  }, [isWaiting])

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = heightRef.current

    const onMouseMove = (ev: MouseEvent) => {
      const newHeight = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, startHeight + (startY - ev.clientY)))
      heightRef.current = newHeight
      setHeight(newHeight)
      localStorage.setItem(INPUT_HEIGHT_KEY, String(newHeight))
    }
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [])

  const handleSend = useCallback(() => {
    if (!value.trim() && pendingFiles.length === 0) return
    onSendInput(value)
    setValue('')
    onValueChange?.('')
  }, [value, pendingFiles, onSendInput, onValueChange])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    } else if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault()
      onSendInput('\x03')
    } else if (e.key === 'Escape') {
      e.preventDefault()
      textareaRef.current?.blur()
      onEscape()
    }
  }, [handleSend, onSendInput, onEscape])

  const handleFileSelect = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files && files.length > 0) {
      onAddFiles(Array.from(files))
    }
    e.target.value = ''
  }, [onAddFiles])

  return (
    <div className="app-input-bar relative flex flex-col border-t border-l border-neutral-7 bg-neutral-9" style={{ height }}>
      <DropZone onUpload={onAddFiles} disabled={disabled} />
      {/* Drag handle */}
      <div
        className="h-1 flex-shrink-0 cursor-row-resize hover:bg-primary-7/40 active:bg-primary-7/60 transition-colors"
        onMouseDown={onDragStart}
      />

      {/* Pending file chips */}
      {pendingFiles.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pt-1.5 flex-shrink-0">
          {pendingFiles.map((file, i) => (
            <span
              key={`${file.name}-${i}`}
              className="flex items-center gap-1 rounded bg-neutral-7 px-2 py-0.5 text-[13px] text-neutral-2"
            >
              <span className="max-w-[150px] truncate">{file.name}</span>
              <button
                onClick={() => onRemoveFile(i)}
                className="flex-shrink-0 rounded p-0.5 text-neutral-4 hover:text-neutral-1"
              >
                <IconX size={12} stroke={2} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-1 min-h-0 gap-2 px-3 py-2">
        {isWaiting && (
          <span className="mt-1 h-2 w-2 flex-shrink-0 rounded-full bg-primary-5 animate-pulse" />
        )}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={e => { setValue(e.target.value); onValueChange?.(e.target.value) }}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          autoFocus
          placeholder={isWaiting ? 'Type response...' : 'What do you want to build?'}
          className="flex-1 min-h-0 resize-none bg-transparent text-[15px] leading-snug text-neutral-1 placeholder:text-neutral-5 outline-none disabled:opacity-50 overflow-y-auto"
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileChange}
          className="hidden"
        />
        <div className="flex flex-shrink-0 flex-row items-end gap-1 pb-0.5">
          {currentModel && onModelChange && (
            <div className="relative">
              <button
                onClick={() => setModelMenuOpen(!modelMenuOpen)}
                className="flex items-center gap-0.5 rounded px-1.5 pb-1 pt-0.5 text-[13px] font-medium text-neutral-4 hover:text-neutral-2 hover:bg-neutral-7 transition-colors"
                title="Change model"
              >
                {shortModelLabel(currentModel)}
                <IconChevronDown size={12} stroke={2} />
              </button>
              {modelMenuOpen && (
                <div className="absolute bottom-full mb-1 right-0 z-50 min-w-[160px] rounded border border-neutral-6 bg-neutral-8 shadow-lg py-1">
                  {MODELS.map(m => (
                    <button
                      key={m.id}
                      onClick={() => { onModelChange(m.id); setModelMenuOpen(false) }}
                      className={`w-full text-left px-3 py-1.5 text-[13px] hover:bg-neutral-7 transition-colors ${m.id === currentModel ? 'text-primary-4' : 'text-neutral-2'}`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {skillGroups && skillGroups.some(g => g.skills.length > 0) && (
            <div className="relative">
              <button
                onClick={() => setSkillMenuOpen(!skillMenuOpen)}
                disabled={disabled}
                className="flex items-center justify-center rounded p-1 text-neutral-3 hover:text-neutral-1 hover:bg-neutral-7 transition-colors disabled:opacity-30"
                title="Claude Skills"
              >
                <IconTerminal2 size={20} stroke={2} />
              </button>
              {skillMenuOpen && (
                <SkillMenu
                  groups={skillGroups}
                  onSelectSkill={(command) => {
                    setValue(command + ' ')
                    setSkillMenuOpen(false)
                    setTimeout(() => textareaRef.current?.focus(), 0)
                  }}
                  onClose={() => setSkillMenuOpen(false)}
                />
              )}
            </div>
          )}
          <button
            onClick={handleFileSelect}
            disabled={disabled}
            className="flex items-center justify-center rounded p-1 text-neutral-3 hover:text-neutral-1 hover:bg-neutral-7 transition-colors disabled:opacity-30"
            title="Attach files"
          >
            <IconPaperclip size={20} stroke={2} />
          </button>
          <button
            onClick={handleSend}
            disabled={disabled || (!value.trim() && pendingFiles.length === 0)}
            className={`flex items-center justify-center rounded p-1 transition-colors disabled:opacity-30 ${
              value.trim() || pendingFiles.length > 0
                ? 'bg-primary-8 text-neutral-1 hover:bg-primary-7'
                : 'text-neutral-5'
            }`}
            title="Send (Enter)"
          >
            <IconSend size={20} stroke={2} />
          </button>
        </div>
      </div>
    </div>
  )
})
