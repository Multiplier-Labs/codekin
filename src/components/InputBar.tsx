/**
 * Chat input bar with textarea, file attachment, skill menu, and
 * inline slash-command autocomplete.
 *
 * Supports Enter to send, Shift+Enter for newline, Ctrl+C to interrupt,
 * Escape to blur. Height is user-draggable via a top handle and persisted
 * to localStorage.
 */

import { useState, useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react'
import { IconSend, IconPaperclip, IconX, IconTerminal2, IconChevronDown, IconDots, IconGitBranch, IconShieldCheck, IconPencil, IconMap2, IconAlertTriangle, IconCheck } from '@tabler/icons-react'
import { SkillMenu, type SkillGroup } from './SkillMenu'
import { SlashAutocomplete } from './SlashAutocomplete'
import { DropZone } from './DropZone'
import type { SlashCommand } from '../lib/slashCommands'
import { PERMISSION_MODES, type PermissionMode } from '../types'

const PERMISSION_MODE_ICONS: Record<string, typeof IconShieldCheck> = {
  shield: IconShieldCheck,
  pencil: IconPencil,
  map: IconMap2,
  warning: IconAlertTriangle,
}

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
  /** Unified list of all slash commands (skills + bundled + built-in). */
  slashCommands?: SlashCommand[]
  initialValue?: string
  onValueChange?: (value: string) => void
  currentModel?: string | null
  onModelChange?: (model: string) => void
  placeholder?: string
  /** When true, disables drag-to-resize and uses auto-height instead */
  isMobile?: boolean
  /** Show the worktree toggle (only before first message in a session). */
  showWorktreeToggle?: boolean
  /** Current worktree toggle state. */
  useWorktree?: boolean
  /** Callback when the worktree toggle is changed. */
  onWorktreeChange?: (checked: boolean) => void
  /** Current permission mode. */
  currentPermissionMode?: PermissionMode
  /** Callback when the permission mode is changed. */
  onPermissionModeChange?: (mode: PermissionMode) => void
}

export const InputBar = forwardRef<InputBarHandle, InputBarProps>(function InputBar({ onSendInput, isWaiting, disabled, onEscape, pendingFiles, onAddFiles, onRemoveFile, skillGroups, slashCommands, initialValue = '', onValueChange, currentModel, onModelChange, placeholder, isMobile = false, showWorktreeToggle = false, useWorktree = false, onWorktreeChange, currentPermissionMode, onPermissionModeChange }, ref) {
  const [value, setValue] = useState(initialValue)
  const [skillMenuOpen, setSkillMenuOpen] = useState(false)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [permMenuOpen, setPermMenuOpen] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [slashMenuOpen, setSlashMenuOpen] = useState(false)
  const [slashFilter, setSlashFilter] = useState('')
  const mobileMenuRef = useRef<HTMLDivElement>(null)
  const permMenuRef = useRef<HTMLDivElement>(null)
  const MOBILE_HEIGHT = 100
  const [height, setHeight] = useState(() => {
    if (isMobile) return MOBILE_HEIGHT
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

  // Auto-focus on waiting transition false → true (skip on mobile to avoid keyboard popup)
  useEffect(() => {
    if (isWaiting && !prevWaiting.current && !isMobile) {
      textareaRef.current?.focus()
    }
    prevWaiting.current = isWaiting
  }, [isWaiting, isMobile])

  // Close mobile context menu on outside click
  useEffect(() => {
    if (!mobileMenuOpen) return
    const handler = (e: MouseEvent) => {
      if (mobileMenuRef.current && !mobileMenuRef.current.contains(e.target as Node)) {
        setMobileMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [mobileMenuOpen])

  // Close permission mode menu on outside click
  useEffect(() => {
    if (!permMenuOpen) return
    const handler = (e: MouseEvent) => {
      if (permMenuRef.current && !permMenuRef.current.contains(e.target as Node)) {
        setPermMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [permMenuOpen])

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
    setSlashMenuOpen(false)
    onSendInput(value)
    setValue('')
    onValueChange?.('')
  }, [value, pendingFiles, onSendInput, onValueChange])

  // --- Slash autocomplete logic ---

  /** Check if the current input should trigger slash autocomplete. */
  const updateSlashMenu = useCallback((text: string) => {
    const trimmed = text.trimStart()
    if (trimmed.startsWith('/')) {
      const spaceIdx = trimmed.indexOf(' ')
      // Only show autocomplete while typing the command itself (before first space)
      if (spaceIdx === -1) {
        setSlashFilter(trimmed.slice(1)) // strip the leading /
        setSlashMenuOpen(true)
        return
      }
    }
    setSlashMenuOpen(false)
    setSlashFilter('')
  }, [])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value
    setValue(newValue)
    onValueChange?.(newValue)
    updateSlashMenu(newValue)
  }, [onValueChange, updateSlashMenu])

  const handleSlashSelect = useCallback((cmd: SlashCommand) => {
    // Insert the command + space, user can type args then press Enter
    const text = cmd.command + ' '
    setValue(text)
    onValueChange?.(text)
    setSlashMenuOpen(false)
    setSlashFilter('')
    setTimeout(() => textareaRef.current?.focus(), 0)
  }, [onValueChange])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return

    // When slash menu is open, Escape closes it instead of blurring
    if (slashMenuOpen && e.key === 'Escape') {
      e.preventDefault()
      setSlashMenuOpen(false)
      return
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      // Don't send when slash menu is open — Enter selects the autocomplete item
      // (cmdk handles this internally via its own keydown)
      if (!slashMenuOpen) {
        e.preventDefault()
        handleSend()
      }
    } else if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault()
      onSendInput('\x03')
    } else if (e.key === 'Escape') {
      e.preventDefault()
      textareaRef.current?.blur()
      onEscape()
    }
  }, [slashMenuOpen, handleSend, onSendInput, onEscape])

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

  const handlePermissionModeSelect = useCallback((mode: PermissionMode) => {
    if (mode === 'bypassPermissions') {
      // Require confirmation for dangerous mode
      const confirmed = window.confirm(
        'Warning: Bypass permissions mode will accept ALL tool calls without asking.\n\n' +
        'This includes file writes, bash commands, and web requests. ' +
        'Only use this if you fully trust the task.\n\n' +
        'Are you sure?'
      )
      if (!confirmed) return
    }
    onPermissionModeChange?.(mode)
    setPermMenuOpen(false)
  }, [onPermissionModeChange])

  const hasSkills = skillGroups && skillGroups.some(g => g.skills.length > 0)
  const hasSlashCommands = slashCommands && slashCommands.length > 0

  return (
    <div className="app-input-bar relative flex flex-col border-t border-l border-neutral-9 bg-neutral-10" style={isMobile ? { minHeight: MOBILE_HEIGHT } : { height }}>
      <DropZone onUpload={onAddFiles} disabled={disabled} />

      {/* Slash autocomplete popup */}
      {slashMenuOpen && hasSlashCommands && (
        <SlashAutocomplete
          commands={slashCommands}
          filter={slashFilter}
          onSelect={handleSlashSelect}
          onClose={() => setSlashMenuOpen(false)}
        />
      )}

      {/* Drag handle — desktop only */}
      {!isMobile && (
        <div
          className="h-1 flex-shrink-0 cursor-row-resize hover:bg-primary-7/40 active:bg-primary-7/60 transition-colors"
          onMouseDown={onDragStart}
        />
      )}

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

      {/* Worktree toggle — only shown before first message */}
      {showWorktreeToggle && (
        <label className="flex items-center gap-1.5 px-3 pt-1 flex-shrink-0 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={useWorktree}
            onChange={(e) => onWorktreeChange?.(e.target.checked)}
            className="accent-primary-6 h-3.5 w-3.5 cursor-pointer"
          />
          <IconGitBranch size={14} stroke={2} className="text-neutral-5" />
          <span className="text-[12px] text-neutral-5">Worktree</span>
        </label>
      )}

      {/* Textarea — full width */}
      <div className="flex flex-1 min-h-0 gap-2 px-3 pt-2 pb-1">
        {isWaiting && (
          <span className="mt-1 h-2 w-2 flex-shrink-0 rounded-full bg-primary-5 animate-pulse" />
        )}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          autoFocus
          placeholder={placeholder ?? (isWaiting ? 'Type response...' : 'What do you want to build?')}
          className={`flex-1 min-h-0 resize-none bg-transparent ${isMobile ? 'text-[16px]' : 'text-[15px]'} leading-snug text-neutral-1 placeholder:text-neutral-5 outline-none disabled:opacity-50 overflow-y-auto`}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/gif,image/webp,text/markdown,.md"
          onChange={handleFileChange}
          className="hidden"
        />
      </div>

      {/* Toolbar row — selectors left, action buttons right */}
      <div className="flex flex-shrink-0 items-center justify-between px-3 pb-2 pt-0">
        {/* Desktop: selectors + action buttons */}
        {!isMobile && (
          <>
            <div className="flex items-center gap-1">
              {/* Permission mode selector */}
              {currentPermissionMode && onPermissionModeChange && (
                <div className="relative" ref={permMenuRef}>
                  <button
                    onClick={() => setPermMenuOpen(!permMenuOpen)}
                    className={`flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium transition-colors ${
                      currentPermissionMode === 'bypassPermissions'
                        ? 'text-error-5 hover:text-error-4 hover:bg-error-9/30'
                        : 'text-neutral-4 hover:text-neutral-2 hover:bg-neutral-7'
                    }`}
                    title="Permission mode"
                  >
                    {(() => {
                      const mode = PERMISSION_MODES.find(m => m.id === currentPermissionMode)
                      const ModeIcon = PERMISSION_MODE_ICONS[mode?.icon ?? 'shield']
                      return <ModeIcon size={14} stroke={2} />
                    })()}
                    <span className="hidden lg:inline">{PERMISSION_MODES.find(m => m.id === currentPermissionMode)?.label ?? currentPermissionMode}</span>
                    <IconChevronDown size={12} stroke={2} />
                  </button>
                  {permMenuOpen && (
                    <div className="absolute bottom-full mb-1 left-0 z-50 min-w-[260px] rounded-lg border border-neutral-6 bg-neutral-8 shadow-lg py-1">
                      {PERMISSION_MODES.map(m => {
                        const ModeIcon = PERMISSION_MODE_ICONS[m.icon]
                        const isActive = m.id === currentPermissionMode
                        return (
                          <button
                            key={m.id}
                            onClick={() => handlePermissionModeSelect(m.id)}
                            className={`w-full text-left px-3 py-2 hover:bg-neutral-7 transition-colors flex items-start gap-2.5 ${
                              m.dangerous ? 'hover:bg-error-9/20' : ''
                            }`}
                          >
                            <ModeIcon
                              size={16}
                              stroke={2}
                              className={`mt-0.5 flex-shrink-0 ${m.dangerous ? 'text-error-5' : isActive ? 'text-primary-4' : 'text-neutral-4'}`}
                            />
                            <div className="flex-1 min-w-0">
                              <div className={`text-[13px] font-medium ${m.dangerous ? 'text-error-5' : isActive ? 'text-primary-4' : 'text-neutral-2'}`}>
                                {m.label}
                              </div>
                              <div className={`text-[12px] ${m.dangerous ? 'text-error-6' : 'text-neutral-5'}`}>
                                {m.description}
                              </div>
                            </div>
                            {isActive && (
                              <IconCheck size={14} stroke={2.5} className="mt-0.5 flex-shrink-0 text-primary-4" />
                            )}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
              {currentModel && onModelChange && (
                <div className="relative">
                  <button
                    onClick={() => setModelMenuOpen(!modelMenuOpen)}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-neutral-4 hover:text-neutral-2 hover:bg-neutral-7 transition-colors"
                    title="Change model"
                  >
                    {shortModelLabel(currentModel)}
                    <IconChevronDown size={12} stroke={2} />
                  </button>
                  {modelMenuOpen && (
                    <div className="absolute bottom-full mb-1 left-0 z-50 min-w-[160px] rounded-lg border border-neutral-6 bg-neutral-8 shadow-lg py-1">
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
              {hasSkills && (
                <div className="relative">
                  <button
                    onClick={() => setSkillMenuOpen(!skillMenuOpen)}
                    disabled={disabled}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-neutral-4 hover:text-neutral-2 hover:bg-neutral-7 transition-colors disabled:opacity-30"
                    title="Claude Skills"
                  >
                    <IconTerminal2 size={14} stroke={2} />
                    <span className="hidden lg:inline">Skills</span>
                    <IconChevronDown size={12} stroke={2} />
                  </button>
                  {skillMenuOpen && (
                    <SkillMenu
                      groups={skillGroups!}
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
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={handleFileSelect}
                disabled={disabled}
                className="flex items-center justify-center rounded-md p-1 text-neutral-4 hover:text-neutral-2 hover:bg-neutral-7 transition-colors disabled:opacity-30"
                title="Attach files"
              >
                <IconPaperclip size={16} stroke={2} />
              </button>
              <button
                onClick={handleSend}
                disabled={disabled || (!value.trim() && pendingFiles.length === 0)}
                className={`flex items-center justify-center rounded-md p-1 transition-colors disabled:opacity-30 ${
                  value.trim() || pendingFiles.length > 0
                    ? 'bg-primary-8 text-neutral-1 hover:bg-primary-7'
                    : 'text-neutral-5'
                }`}
                title="Send (Enter)"
              >
                <IconSend size={16} stroke={2} />
              </button>
            </div>
          </>
        )}

        {/* Mobile: context menu (...) + send button only */}
        {isMobile && (
          <>
            <div className="flex-1" />
            <div className="flex items-center gap-1.5">
              <div className="relative" ref={mobileMenuRef}>
                <button
                  onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                  disabled={disabled}
                  className="flex items-center justify-center rounded min-w-[34px] min-h-[34px] p-1.5 text-neutral-3 hover:text-neutral-1 hover:bg-neutral-7 transition-colors disabled:opacity-30"
                  title="More options"
                >
                  <IconDots size={24} stroke={2} />
                </button>
                {mobileMenuOpen && (
                  <div className="absolute bottom-full mb-1 right-0 z-50 min-w-[220px] rounded-lg border border-neutral-6 bg-neutral-8 shadow-lg py-1">
                    {/* Permission mode selector */}
                    {currentPermissionMode && onPermissionModeChange && (
                      <>
                        <div className="px-3 py-1.5 text-[12px] text-neutral-5 uppercase tracking-wider">Permissions</div>
                        {PERMISSION_MODES.map(m => {
                          const ModeIcon = PERMISSION_MODE_ICONS[m.icon]
                          const isActive = m.id === currentPermissionMode
                          return (
                            <button
                              key={m.id}
                              onClick={() => { handlePermissionModeSelect(m.id); setMobileMenuOpen(false) }}
                              className={`w-full text-left px-3 py-2 text-[14px] hover:bg-neutral-7 transition-colors flex items-center gap-2 ${
                                m.dangerous ? 'hover:bg-error-9/20' : ''
                              }`}
                            >
                              <ModeIcon
                                size={16}
                                stroke={2}
                                className={m.dangerous ? 'text-error-5' : isActive ? 'text-primary-4' : 'text-neutral-4'}
                              />
                              <span className={m.dangerous ? 'text-error-5' : isActive ? 'text-primary-4' : 'text-neutral-2'}>
                                {m.label}
                              </span>
                              {isActive && <IconCheck size={14} stroke={2.5} className="ml-auto text-primary-4" />}
                            </button>
                          )
                        })}
                        <div className="my-1 border-t border-neutral-7" />
                      </>
                    )}
                    {/* Model selector */}
                    {currentModel && onModelChange && (
                      <>
                        <div className="px-3 py-1.5 text-[12px] text-neutral-5 uppercase tracking-wider">Model</div>
                        {MODELS.map(m => (
                          <button
                            key={m.id}
                            onClick={() => { onModelChange(m.id); setMobileMenuOpen(false) }}
                            className={`w-full text-left px-3 py-2 text-[14px] hover:bg-neutral-7 transition-colors ${m.id === currentModel ? 'text-primary-4' : 'text-neutral-2'}`}
                          >
                            {m.label}
                          </button>
                        ))}
                        <div className="my-1 border-t border-neutral-7" />
                      </>
                    )}
                    {/* Skills */}
                    {hasSkills && (
                      <button
                        onClick={() => { setMobileMenuOpen(false); setSkillMenuOpen(!skillMenuOpen) }}
                        className="flex items-center gap-2 w-full text-left px-3 py-2 text-[14px] text-neutral-2 hover:bg-neutral-7 transition-colors"
                      >
                        <IconTerminal2 size={18} stroke={2} className="text-neutral-4" />
                        Skills
                      </button>
                    )}
                    {/* Attach files */}
                    <button
                      onClick={() => { setMobileMenuOpen(false); handleFileSelect() }}
                      className="flex items-center gap-2 w-full text-left px-3 py-2 text-[14px] text-neutral-2 hover:bg-neutral-7 transition-colors"
                    >
                      <IconPaperclip size={18} stroke={2} className="text-neutral-4" />
                      Attach files
                    </button>
                  </div>
                )}
                {skillMenuOpen && (
                  <SkillMenu
                    groups={skillGroups!}
                    onSelectSkill={(command) => {
                      setValue(command + ' ')
                      setSkillMenuOpen(false)
                      setTimeout(() => textareaRef.current?.focus(), 0)
                    }}
                    onClose={() => setSkillMenuOpen(false)}
                  />
                )}
              </div>
              <button
                onClick={handleSend}
                disabled={disabled || (!value.trim() && pendingFiles.length === 0)}
                className={`flex items-center justify-center rounded min-w-[34px] min-h-[34px] p-1.5 transition-colors disabled:opacity-30 ${
                  value.trim() || pendingFiles.length > 0
                    ? 'bg-primary-8 text-neutral-1 hover:bg-primary-7'
                    : 'text-neutral-5'
                }`}
                title="Send (Enter)"
              >
                <IconSend size={24} stroke={2} />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
})
