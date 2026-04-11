/**
 * Chat input bar with textarea, file attachment, skill menu, and
 * inline slash-command autocomplete.
 *
 * Supports Enter to send, Shift+Enter for newline, Ctrl+C to interrupt,
 * Escape to blur. Height is user-draggable via a top handle and persisted
 * to localStorage.
 */

import { useState, useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react'
import { useOutsideClick } from '../hooks/useOutsideClick'
import { IconSend, IconPaperclip, IconX, IconTerminal2, IconChevronDown, IconDots, IconGitBranch, IconShieldCheck, IconPencil, IconMap2, IconAlertTriangle, IconCheck } from '@tabler/icons-react'
import { SkillMenu, type SkillGroup } from './SkillMenu'
import { SlashAutocomplete } from './SlashAutocomplete'
import { DropZone } from './DropZone'
import type { SlashCommand } from '../lib/slashCommands'
import { PERMISSION_MODES, type PermissionMode, type ModelOption } from '../types'

const PERMISSION_MODE_ICONS: Record<string, typeof IconShieldCheck> = {
  shield: IconShieldCheck,
  pencil: IconPencil,
  map: IconMap2,
  warning: IconAlertTriangle,
}

function shortModelLabel(modelId: string, models: ModelOption[]): string {
  return models.find(m => m.id === modelId)?.label ?? modelId.replace(/^claude-/, '')
}

// ---------------------------------------------------------------------------
// Shared toolbar atoms — extracted to eliminate duplication across variants
// ---------------------------------------------------------------------------

/** Attach-files button with configurable size and rounding. */
function AttachButton({ onClick, disabled, size = 16, rounded = 'rounded-md', className = '' }: {
  onClick: () => void; disabled: boolean; size?: number; rounded?: string; className?: string
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center justify-center ${rounded} p-1.5 text-neutral-4 hover:text-neutral-2 hover:bg-neutral-7 transition-colors disabled:opacity-30 ${className}`}
      title="Attach files"
    >
      <IconPaperclip size={size} stroke={2} />
    </button>
  )
}

/** Send button with configurable accent theme and size. */
function SendButton({ onClick, disabled, hasContent, size = 16, rounded = 'rounded-md', accent = false, className = '' }: {
  onClick: () => void; disabled: boolean; hasContent: boolean; size?: number; rounded?: string; accent?: boolean; className?: string
}) {
  const activeClass = accent
    ? 'bg-accent-7 text-neutral-1 hover:bg-accent-6'
    : 'bg-primary-8 text-neutral-1 hover:bg-primary-7'
  return (
    <button
      onClick={onClick}
      disabled={disabled || !hasContent}
      className={`flex items-center justify-center ${rounded} p-1.5 transition-colors disabled:opacity-30 ${
        hasContent ? activeClass : 'text-neutral-5'
      } ${className}`}
      title="Send (Enter)"
    >
      <IconSend size={size} stroke={2} />
    </button>
  )
}

/** Desktop permission mode dropdown with full descriptions. */
function PermissionModeDropdown({ currentMode, isOpen, menuRef, onToggle, onSelect }: {
  currentMode: PermissionMode; isOpen: boolean
  menuRef: React.RefObject<HTMLDivElement | null>
  onToggle: () => void; onSelect: (mode: PermissionMode) => void
}) {
  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={onToggle}
        className={`flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium transition-colors ${
          currentMode === 'bypassPermissions'
            ? 'text-error-5 hover:text-error-4 hover:bg-error-9/30'
            : 'text-neutral-4 hover:text-neutral-2 hover:bg-neutral-7'
        }`}
        title="Permission mode"
      >
        {(() => {
          const mode = PERMISSION_MODES.find(m => m.id === currentMode)
          const ModeIcon = PERMISSION_MODE_ICONS[mode?.icon ?? 'shield']
          return <ModeIcon size={14} stroke={2} />
        })()}
        <span className="hidden lg:inline">{PERMISSION_MODES.find(m => m.id === currentMode)?.label ?? currentMode}</span>
        <IconChevronDown size={12} stroke={2} />
      </button>
      {isOpen && (
        <div className="absolute bottom-full mb-1 left-0 z-50 min-w-[260px] rounded-lg border border-neutral-6 bg-neutral-8 shadow-lg py-1">
          {PERMISSION_MODES.map(m => {
            const ModeIcon = PERMISSION_MODE_ICONS[m.icon]
            const isActive = m.id === currentMode
            return (
              <button
                key={m.id}
                onClick={() => onSelect(m.id)}
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
  )
}

/** Model selector dropdown. */
function ModelDropdown({ currentModel, models, isOpen, menuRef, onToggle, onChange }: {
  currentModel: string; models: ModelOption[]; isOpen: boolean
  menuRef: React.RefObject<HTMLDivElement | null>
  onToggle: () => void; onChange: (model: string) => void
}) {
  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={onToggle}
        className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-neutral-4 hover:text-neutral-2 hover:bg-neutral-7 transition-colors"
        title="Change model"
      >
        {shortModelLabel(currentModel, models)}
        <IconChevronDown size={12} stroke={2} />
      </button>
      {isOpen && (
        <div className="absolute bottom-full mb-1 right-0 z-50 min-w-[160px] max-h-[320px] overflow-y-auto rounded-lg border border-neutral-6 bg-neutral-8 shadow-lg py-1">
          {models.map(m => (
            <button
              key={m.id}
              onClick={() => onChange(m.id)}
              className={`w-full text-left px-3 py-1.5 text-[13px] hover:bg-neutral-7 transition-colors ${m.id === currentModel ? 'text-primary-4' : 'text-neutral-2'}`}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const INPUT_HEIGHT_KEY = 'inputBarHeight'
const DEFAULT_HEIGHT = 120
const MIN_HEIGHT = 60
const MAX_HEIGHT = 600

/** Imperative handle for programmatic text insertion (e.g. from skill menu). */
export interface InputBarHandle {
  insertText: (text: string) => void
}

export type InputBarVariant = 'default' | 'orchestrator'

interface InputBarProps {
  /** Called with the raw text when the user sends a message (Enter key or send button). */
  onSendInput: (data: string) => void
  /** True when Claude is waiting for user input (prompt mode). */
  isWaiting: boolean
  /** When true, textarea and action buttons are disabled (e.g. no auth token). */
  disabled: boolean
  /** Called when the user presses Escape — parent uses this to deselect the session. */
  onEscape: () => void
  /** Files queued for upload alongside the next message. */
  pendingFiles: File[]
  /** Append files to the pending upload queue. */
  onAddFiles: (files: File[]) => void
  /** Remove a file from the pending queue by index. */
  onRemoveFile: (index: number) => void
  /** Skill groups for the toolbar skill menu (omit or empty to hide the menu). */
  skillGroups?: SkillGroup[]
  /** Unified list of all slash commands (skills + bundled + built-in). */
  slashCommands?: SlashCommand[]
  /** Pre-populate the textarea (e.g. when restoring a draft). */
  initialValue?: string
  /** Controlled callback — fires on every keystroke so the parent can persist drafts. */
  onValueChange?: (value: string) => void
  /** Currently selected Claude model ID, shown in the model picker. Omit to hide picker. */
  currentModel?: string | null
  /** Called when the user selects a different model from the picker. */
  onModelChange?: (model: string) => void
  /** Available models for the current provider. */
  availableModels?: ModelOption[]
  /** Override the default placeholder text in the textarea. */
  placeholder?: string
  /** When true, disables drag-to-resize and uses auto-height instead. */
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
  /** Callback to move the current session into a worktree mid-session. */
  onMoveToWorktree?: () => void
  /** Worktree path if the session is in a worktree (falsy = not in worktree). */
  worktreePath?: string | null
  /** Visual variant — 'orchestrator' strips toolbar to attach+send only with accent theme. */
  variant?: InputBarVariant
}

export const InputBar = forwardRef<InputBarHandle, InputBarProps>(function InputBar({ onSendInput, isWaiting, disabled, onEscape, pendingFiles, onAddFiles, onRemoveFile, skillGroups, slashCommands, initialValue = '', onValueChange, currentModel, onModelChange, availableModels = [], placeholder, isMobile = false, showWorktreeToggle = false, useWorktree = false, onWorktreeChange, currentPermissionMode, onPermissionModeChange, onMoveToWorktree, worktreePath, variant = 'default' }, ref) {
  const isOrchestrator = variant === 'orchestrator'
  const [value, setValue] = useState(initialValue)
  const [skillMenuOpen, setSkillMenuOpen] = useState(false)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [permMenuOpen, setPermMenuOpen] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [slashMenuOpen, setSlashMenuOpen] = useState(false)

  /** Close all toolbar popups, optionally keeping one open. */
  const closeAllPopups = useCallback((except?: 'skill' | 'model' | 'perm') => {
    if (except !== 'skill') setSkillMenuOpen(false)
    if (except !== 'model') setModelMenuOpen(false)
    if (except !== 'perm') setPermMenuOpen(false)
  }, [])
  const [slashFilter, setSlashFilter] = useState('')
  const mobileMenuRef = useRef<HTMLDivElement>(null)
  const permMenuRef = useRef<HTMLDivElement>(null)
  const modelMenuRef = useRef<HTMLDivElement>(null)
  const MOBILE_HEIGHT = 100
  const ORCH_HEIGHT_KEY = 'orchestratorInputBarHeight'
  const ORCHESTRATOR_DEFAULT_HEIGHT = 90
  const [height, setHeight] = useState(() => {
    if (isMobile) return MOBILE_HEIGHT
    const key = isOrchestrator ? ORCH_HEIGHT_KEY : INPUT_HEIGHT_KEY
    const defaultH = isOrchestrator ? ORCHESTRATOR_DEFAULT_HEIGHT : DEFAULT_HEIGHT
    const stored = localStorage.getItem(key)
    return stored ? Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, parseInt(stored, 10))) : defaultH
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

  // Close dropdown menus on outside click
  useOutsideClick(mobileMenuRef, mobileMenuOpen, useCallback(() => setMobileMenuOpen(false), []))
  useOutsideClick(permMenuRef, permMenuOpen, useCallback(() => setPermMenuOpen(false), []))
  useOutsideClick(modelMenuRef, modelMenuOpen, useCallback(() => setModelMenuOpen(false), []))

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = heightRef.current

    const onMouseMove = (ev: MouseEvent) => {
      const newHeight = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, startHeight + (startY - ev.clientY)))
      heightRef.current = newHeight
      setHeight(newHeight)
      localStorage.setItem(isOrchestrator ? ORCH_HEIGHT_KEY : INPUT_HEIGHT_KEY, String(newHeight))
    }
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [isOrchestrator])

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

  const hasSkills = !isOrchestrator && skillGroups && skillGroups.some(g => g.skills.length > 0)
  const hasSlashCommands = !isOrchestrator && slashCommands && slashCommands.length > 0

  return (
    <div className={`app-input-bar relative flex flex-col border-l bg-neutral-10 ${isOrchestrator ? 'orchestrator-input-bar border-t border-neutral-9' : 'border-t border-neutral-9'}`} style={isMobile ? { minHeight: MOBILE_HEIGHT } : { height }}>
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

      {/* Worktree checkbox removed — use the footer button instead */}

      {/* Textarea — full width */}
      <div className="flex flex-1 min-h-0 gap-2 px-3 pt-2 pb-1">
        {isWaiting && (
          <span className={`mt-1 h-2 w-2 flex-shrink-0 rounded-full animate-pulse ${isOrchestrator ? 'bg-accent-5' : 'bg-primary-5'}`} />
        )}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          autoFocus
          placeholder={placeholder ?? (isOrchestrator ? 'Ask the orchestrator...' : isWaiting ? 'Type response...' : 'What do you want to build?')}
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
        {/* Desktop default: permission + worktree | model + skills + attach + send */}
        {!isMobile && !isOrchestrator && (
          <>
            <div className="flex items-center gap-1">
              {currentPermissionMode && onPermissionModeChange && (
                <PermissionModeDropdown
                  currentMode={currentPermissionMode}
                  isOpen={permMenuOpen}
                  menuRef={permMenuRef}
                  onToggle={() => { closeAllPopups('perm'); setPermMenuOpen(!permMenuOpen) }}
                  onSelect={handlePermissionModeSelect}
                />
              )}
              {/* Worktree: indicator when active, toggle before first message, or move button mid-session */}
              {worktreePath ? (
                <span
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-primary-5"
                  title={worktreePath}
                >
                  <IconGitBranch size={14} stroke={2} />
                  <span className="hidden lg:inline max-w-[120px] truncate">{worktreePath.split('/').pop()}</span>
                </span>
              ) : showWorktreeToggle && onWorktreeChange ? (
                <button
                  onClick={() => onWorktreeChange(!useWorktree)}
                  className={`flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium transition-colors ${
                    useWorktree
                      ? 'text-primary-5 bg-primary-9/30 hover:bg-primary-9/50'
                      : 'text-neutral-4 hover:text-neutral-2 hover:bg-neutral-7'
                  }`}
                  title={useWorktree ? 'Worktree enabled — session will use a git worktree' : 'Enable git worktree for this session'}
                >
                  <IconGitBranch size={14} stroke={2} />
                  <span className="hidden lg:inline">Worktree</span>
                </button>
              ) : onMoveToWorktree ? (
                <button
                  onClick={onMoveToWorktree}
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-neutral-4 hover:text-neutral-2 hover:bg-neutral-7 transition-colors"
                  title="Move session to a git worktree"
                >
                  <IconGitBranch size={14} stroke={2} />
                  <span className="hidden lg:inline">Worktree</span>
                </button>
              ) : null}
            </div>
            <div className="flex items-center gap-1">
              {currentModel && onModelChange && (
                <ModelDropdown
                  currentModel={currentModel}
                  models={availableModels}
                  isOpen={modelMenuOpen}
                  menuRef={modelMenuRef}
                  onToggle={() => { closeAllPopups('model'); setModelMenuOpen(!modelMenuOpen) }}
                  onChange={(id) => { onModelChange(id); setModelMenuOpen(false) }}
                />
              )}
              {hasSkills && (
                <div className="relative">
                  <button
                    onClick={() => { closeAllPopups('skill'); setSkillMenuOpen(!skillMenuOpen) }}
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
                      groups={skillGroups ?? []}
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
              <AttachButton onClick={handleFileSelect} disabled={disabled} size={16} rounded="rounded-md" />
              <SendButton onClick={handleSend} disabled={disabled} hasContent={!!(value.trim() || pendingFiles.length > 0)} size={16} rounded="rounded-md" />
            </div>
          </>
        )}

        {/* Desktop orchestrator: attach + send only (accent theme) */}
        {!isMobile && isOrchestrator && (
          <>
            <div className="flex-1" />
            <div className="flex items-center gap-1.5">
              <AttachButton onClick={handleFileSelect} disabled={disabled} size={16} rounded="rounded-full" className="hover:text-accent-4 hover:bg-accent-9/30" />
              <SendButton onClick={handleSend} disabled={disabled} hasContent={!!(value.trim() || pendingFiles.length > 0)} size={16} rounded="rounded-full" accent className="px-3 py-1" />
            </div>
          </>
        )}

        {/* Mobile default: context menu (...) + send */}
        {isMobile && !isOrchestrator && (
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
                    {currentModel && onModelChange && (
                      <>
                        <div className="px-3 py-1.5 text-[12px] text-neutral-5 uppercase tracking-wider">Model</div>
                        {availableModels.map(m => (
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
                    {hasSkills && (
                      <button
                        onClick={() => { setMobileMenuOpen(false); setSkillMenuOpen(!skillMenuOpen) }}
                        className="flex items-center gap-2 w-full text-left px-3 py-2 text-[14px] text-neutral-2 hover:bg-neutral-7 transition-colors"
                      >
                        <IconTerminal2 size={18} stroke={2} className="text-neutral-4" />
                        Skills
                      </button>
                    )}
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
                    groups={skillGroups ?? []}
                    onSelectSkill={(command) => {
                      setValue(command + ' ')
                      setSkillMenuOpen(false)
                      setTimeout(() => textareaRef.current?.focus(), 0)
                    }}
                    onClose={() => setSkillMenuOpen(false)}
                  />
                )}
              </div>
              <SendButton onClick={handleSend} disabled={disabled} hasContent={!!(value.trim() || pendingFiles.length > 0)} size={24} rounded="rounded" className="min-w-[34px] min-h-[34px]" />
            </div>
          </>
        )}

        {/* Mobile orchestrator: attach + send only (accent theme) */}
        {isMobile && isOrchestrator && (
          <>
            <div className="flex-1" />
            <div className="flex items-center gap-1.5">
              <AttachButton onClick={handleFileSelect} disabled={disabled} size={24} rounded="rounded-full" className="min-w-[34px] min-h-[34px] hover:text-accent-4 hover:bg-accent-9/30" />
              <SendButton onClick={handleSend} disabled={disabled} hasContent={!!(value.trim() || pendingFiles.length > 0)} size={24} rounded="rounded-full" accent className="min-w-[34px] min-h-[34px]" />
            </div>
          </>
        )}
      </div>
    </div>
  )
})
