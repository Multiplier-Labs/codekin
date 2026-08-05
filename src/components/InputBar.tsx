/**
 * Chat input bar with textarea, file attachment, skill menu, and
 * inline slash-command autocomplete.
 *
 * Supports Enter to send, Shift+Enter for newline, Ctrl+C to interrupt,
 * Escape to blur. The textarea sizes itself to its content, from two lines up
 * to 40% of the pane; the toolbar below it is one row, split into session
 * state (left, unboxed monospace) and actions (right, exactly one filled).
 */

import { useState, useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react'
import { useOutsideClick } from '../hooks/useOutsideClick'
import { useAutoGrow } from '../hooks/useAutoGrow'
import { IconPlus, IconX, IconTerminal2, IconChevronDown, IconDots, IconGitBranch, IconGitBranchDeleted, IconShieldCheck, IconPencil, IconMap2, IconAlertTriangle, IconCheck, IconCornerDownLeft } from '@tabler/icons-react'
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

/** Square icon action — one of the composer's right-hand controls. */
function ToolbarAction({ onClick, disabled, title, accent = false, children }: {
  onClick: () => void; disabled?: boolean; title: string; accent?: boolean; children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`composer-row aspect-square flex items-center justify-center rounded-control text-ink-muted transition-colors disabled:opacity-30 ${
        accent ? 'hover:text-accent-4 hover:bg-surface-raised' : 'hover:text-ink hover:bg-surface-raised'
      }`}
      title={title}
    >
      {children}
    </button>
  )
}

/**
 * Attach-files button. A `+` rather than a paperclip, matching the convention
 * other LLM composers have settled on; the title still says what it takes,
 * since the picker only accepts images and markdown.
 */
function AttachButton({ onClick, disabled, accent = false }: { onClick: () => void; disabled: boolean; accent?: boolean }) {
  return (
    <ToolbarAction onClick={onClick} disabled={disabled} title="Attach images or markdown" accent={accent}>
      <IconPlus className="density-icon" stroke={2} />
    </ToolbarAction>
  )
}

/**
 * The composer's only filled control. Labelled rather than icon-only, and
 * sized from --row-h so touch density lifts it to 44px. Disabled state uses a
 * muted fill instead of a faded primary, which is hard to find.
 */
function SendButton({ onClick, disabled, hasContent, accent = false }: {
  onClick: () => void; disabled: boolean; hasContent: boolean; accent?: boolean
}) {
  const isDisabled = disabled || !hasContent
  const activeClass = accent
    ? 'bg-accent-5 text-ink-inverse hover:bg-accent-4'
    : 'bg-primary-fill text-on-primary-fill hover:brightness-105'
  return (
    <button
      onClick={onClick}
      disabled={isDisabled}
      className={`composer-row flex items-center gap-2 rounded-control px-3.5 text-body font-bold transition-colors ${
        isDisabled ? 'bg-edge-strong text-ink-muted' : activeClass
      }`}
      title="Send (Enter)"
    >
      Send
      <IconCornerDownLeft size={12} stroke={2} className="opacity-65" />
    </button>
  )
}

/**
 * Unboxed session-state item: monospace, muted, no chip and no border.
 *
 * `group/state` lets a child label collapse to nothing and expand on hover or
 * keyboard focus — see StateLabel. The `title` carries the same text for touch,
 * where there is no hover.
 */
function StateItem({ children, title, onClick, danger = false, innerRef }: {
  children: React.ReactNode; title?: string; onClick?: () => void; danger?: boolean
  innerRef?: React.Ref<HTMLButtonElement>
}) {
  const tone = danger ? 'text-warning-4' : 'text-ink-muted hover:text-ink'
  const className = `group/state flex items-center gap-1.5 font-mono text-meta whitespace-nowrap transition-colors ${tone}`
  if (!onClick) return <span className={className} title={title}>{children}</span>
  return (
    <button ref={innerRef} onClick={onClick} className={className} title={title}>
      {children}
    </button>
  )
}

/**
 * A state item's text, hidden until its item is hovered or focused. Kept in the
 * DOM (rather than conditionally rendered) so screen readers and find-in-page
 * still see it.
 */
function StateLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="sr-only group-hover/state:not-sr-only group-focus-visible/state:not-sr-only">
      {children}
    </span>
  )
}

/** Desktop permission mode dropdown with full descriptions. */
function PermissionModeDropdown({ currentMode, modes, isOpen, menuRef, onToggle, onSelect }: {
  currentMode: PermissionMode; modes: typeof PERMISSION_MODES; isOpen: boolean
  menuRef: React.RefObject<HTMLDivElement | null>
  onToggle: () => void; onSelect: (mode: PermissionMode) => void
}) {
  const mode = PERMISSION_MODES.find(m => m.id === currentMode)
  const ModeIcon = PERMISSION_MODE_ICONS[mode?.icon ?? 'shield']
  return (
    <div className="relative" ref={menuRef}>
      <StateItem onClick={onToggle} title={`Permission mode: ${mode?.label ?? currentMode}`} danger={!!mode?.dangerous}>
        <ModeIcon size={14} stroke={2} />
        <StateLabel>{mode?.label ?? currentMode}</StateLabel>
        <IconChevronDown size={12} stroke={2} className="opacity-70" />
      </StateItem>
      {isOpen && (
        <div className="absolute bottom-full mb-1 left-0 z-50 min-w-[260px] rounded-floating border border-edge-strong bg-surface-raised shadow-floating py-1">
          {modes.map(m => {
            const ModeIcon = PERMISSION_MODE_ICONS[m.icon]
            const isActive = m.id === currentMode
            return (
              <button
                key={m.id}
                onClick={() => onSelect(m.id)}
                className={`w-full text-left px-3 py-2 hover:bg-edge transition-colors flex items-start gap-2.5 ${
                  m.dangerous ? 'hover:bg-error-9/20' : ''
                }`}
              >
                <ModeIcon
                  size={16}
                  stroke={2}
                  className={`mt-0.5 flex-shrink-0 ${m.dangerous ? 'text-error-5' : isActive ? 'text-primary-4' : 'text-ink-muted'}`}
                />
                <div className="flex-1 min-w-0">
                  <div className={`text-body font-medium ${m.dangerous ? 'text-error-5' : isActive ? 'text-primary-4' : 'text-ink'}`}>
                    {m.label}
                  </div>
                  <div className={`text-meta ${m.dangerous ? 'text-error-6' : 'text-ink-muted'}`}>
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
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [prevIsOpen, setPrevIsOpen] = useState(isOpen)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const RECENTS_KEY = 'codekin.recentModels'

  // Reset active index when isOpen prop changes (React-recommended
  // "adjusting state based on props" pattern — no useEffect needed)
  if (isOpen !== prevIsOpen) {
    setPrevIsOpen(isOpen)
    setActiveIndex(0)
  }

  const getRecents = (): string[] => {
    try { return JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]') as string[] } catch { return [] }
  }

  const addRecent = (id: string) => {
    const next = getRecents().filter(m => m !== id)
    next.unshift(id)
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next.slice(0, 5)))
  }

  const recents = getRecents().filter(id => models.some(m => m.id === id))

  const filtered = query
    ? models.filter(m =>
        m.id.toLowerCase().includes(query.toLowerCase()) ||
        m.label.toLowerCase().includes(query.toLowerCase())
      )
    : models

  const recentSet = new Set(recents)
  const allModelsFiltered = (!query && recents.length > 0)
    ? filtered.filter(m => !recentSet.has(m.id))
    : filtered
  const visibleList = (!query && recents.length > 0
    ? [...recents.map(id => models.find(m => m.id === id)).filter(Boolean) as ModelOption[], ...allModelsFiltered]
    : filtered)

  useEffect(() => {
    const el = itemRefs.current[activeIndex]
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!visibleList.length) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex(i => Math.min(i + 1, visibleList.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const m = visibleList[activeIndex]
      if (m) { addRecent(m.id); onChange(m.id) }
    }
  }

  return (
    <div className="relative" ref={menuRef}>
      <StateItem onClick={onToggle} title="Change model">
        {shortModelLabel(currentModel, models)}
        <IconChevronDown size={12} stroke={2} className="opacity-70" />
      </StateItem>
      {isOpen && (
        <div className="absolute bottom-full mb-1 right-0 z-50 w-[260px] max-h-[360px] rounded-floating border border-edge-strong bg-surface-raised shadow-floating flex flex-col">
          <div className="p-2 border-b border-edge-strong">
            <input
              autoFocus
              value={query}
              onChange={e => { setQuery(e.target.value); setActiveIndex(0) }}
              onKeyDown={handleKeyDown}
              placeholder="Search models..."
              className="w-full bg-edge-strong text-body px-2 py-1.5 rounded-control outline-none text-ink placeholder:text-ink-muted"
            />
          </div>

          <div className="overflow-y-auto py-1">
            {!query && recents.length > 0 && (
              <div className="mb-1">
                <div className="px-3 py-1 text-micro text-ink-muted">Recent</div>
                {recents.map((id, idx) => {
                  const m = models.find(x => x.id === id)
                  if (!m) return null
                  const index = idx
                  return (
                    <button
                      key={m.id}
                      ref={el => { itemRefs.current[index] = el }}
                      onClick={() => { addRecent(m.id); onChange(m.id) }}
                      className={`w-full text-left px-3 py-1.5 text-body transition-colors ${index === activeIndex ? 'bg-edge' : 'hover:bg-edge'} ${m.id === currentModel ? 'text-primary-4' : 'text-ink'}`}
                    >
                      {m.label}
                    </button>
                  )
                })}
              </div>
            )}

            <div>
              {!query && (
                <div className="px-3 py-1 text-micro text-ink-muted">All Models</div>
              )}
              {allModelsFiltered.map((m, idx) => {
                const baseIndex = (!query && recents.length > 0) ? recents.length : 0
                const index = baseIndex + idx
                return (
                <button
                  key={m.id}
                  ref={el => { itemRefs.current[index] = el }}
                  onClick={() => { addRecent(m.id); onChange(m.id) }}
                  className={`w-full text-left px-3 py-1.5 text-body transition-colors ${index === activeIndex ? 'bg-edge' : 'hover:bg-edge'} ${m.id === currentModel ? 'text-primary-4' : 'text-ink'}`}
                >
                  {m.label}
                </button>
              )})}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

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
  /** Coding provider of the active session — filters provider-specific permission modes. */
  sessionProvider?: import('../types').CodingProvider
  /** Override the default placeholder text in the textarea. */
  placeholder?: string
  /** Narrow-viewport hint — suppresses autofocus so the keyboard doesn't pop up. */
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

export const InputBar = forwardRef<InputBarHandle, InputBarProps>(function InputBar({ onSendInput, isWaiting, disabled, onEscape, pendingFiles, onAddFiles, onRemoveFile, skillGroups, slashCommands, initialValue = '', onValueChange, currentModel, onModelChange, availableModels = [], sessionProvider, placeholder, isMobile = false, showWorktreeToggle = false, useWorktree = false, onWorktreeChange, currentPermissionMode, onPermissionModeChange, onMoveToWorktree, worktreePath, variant = 'default' }, ref) {
  const isOrchestrator = variant === 'orchestrator'
  // OpenCode and Codex have no equivalent of Claude's --dangerously-skip-permissions
  // flag; bypassPermissions already covers that use case for both.
  const visibleModes = sessionProvider === 'opencode' || sessionProvider === 'codex'
    ? PERMISSION_MODES.filter(m => m.id !== 'dangerouslySkipPermissions')
    : PERMISSION_MODES
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
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const prevWaiting = useRef(false)

  // Height follows content — no stored height, no drag handle.
  useAutoGrow(textareaRef, value)

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
    // Require confirmation for any dangerous mode (bypassPermissions,
    // dangerouslySkipPermissions) before activating.
    if (PERMISSION_MODES.find(m => m.id === mode)?.dangerous) {
      const label = PERMISSION_MODES.find(m => m.id === mode)?.label ?? mode
      const confirmed = window.confirm(
        `Warning: "${label}" will accept ALL tool calls without asking.\n\n` +
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

  // Session state (left) and actions (right). The orchestrator variant is a
  // filter over these plus an accent flag — not a second layout.
  const showPermission = !isOrchestrator && !!currentPermissionMode && !!onPermissionModeChange
  const showModel = !isOrchestrator && !!currentModel && !!onModelChange
  const showWorktree = !isOrchestrator && (!!worktreePath || (showWorktreeToggle && !!onWorktreeChange) || !!onMoveToWorktree)
  // Anything beyond the permission chip folds into the overflow menu on a
  // narrow composer; a dangerous mode must stay visible at every width.
  const hasOverflow = showModel || showWorktree

  return (
    <div className={`app-input-bar @container relative flex flex-col ${isOrchestrator ? 'orchestrator-input-bar' : ''}`}>
      {/* Exactly the transcript row's padding, so the card's edges land on the
          prose edges at every width. Nothing here reads the pane width. */}
      <div className="px-4 pb-3 pt-1 @[32rem]:px-12">
        <div className="composer-card relative mx-auto flex w-full min-w-0 max-w-[var(--measure)] flex-col gap-2 rounded-control border border-edge bg-surface pt-2.5 pr-3 pb-2 pl-3">
          <DropZone onUpload={onAddFiles} disabled={disabled} />

          {/* Slash autocomplete popup — anchored to the measured column */}
          {slashMenuOpen && hasSlashCommands && (
            <SlashAutocomplete
              commands={slashCommands}
              filter={slashFilter}
              onSelect={handleSlashSelect}
              onClose={() => setSlashMenuOpen(false)}
            />
          )}

          {/* Pending file chips */}
          {pendingFiles.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {pendingFiles.map((file, i) => (
                <span
                  key={`${file.name}-${i}`}
                  className="flex items-center gap-1 rounded-control bg-edge-strong px-2 py-0.5 text-meta text-ink"
                >
                  <span className="max-w-[150px] truncate">{file.name}</span>
                  <button
                    onClick={() => onRemoveFile(i)}
                    className="flex-shrink-0 rounded-control p-0.5 text-ink-muted hover:text-ink"
                    title={`Remove ${file.name}`}
                  >
                    <IconX size={12} stroke={2} />
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            {isWaiting && (
              <span className={`mt-1.5 h-2 w-2 flex-shrink-0 rounded-full animate-pulse ${isOrchestrator ? 'bg-accent-5' : 'bg-primary-5'}`} />
            )}
            <textarea
              ref={textareaRef}
              rows={2}
              value={value}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              disabled={disabled}
              autoFocus={!isMobile}
              placeholder={placeholder ?? (isOrchestrator ? 'Ask the orchestrator...' : isWaiting ? 'Type response...' : 'What do you want to build?')}
              // Mobile must stay 16px: font sizes under 16px trigger iOS Safari zoom-on-focus
              className={`composer-textarea field-sizing-content max-h-[40vh] w-full flex-1 resize-none bg-transparent ${isMobile ? 'text-[16px]' : 'text-body'} text-ink placeholder:text-ink-muted outline-none disabled:opacity-50 overflow-y-auto`}
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

          {/* One toolbar: attach on the left rail, state and actions on the
              right — the arrangement the reference composer uses. */}
          <div className="flex items-center gap-3">
            <AttachButton onClick={handleFileSelect} disabled={disabled} accent={isOrchestrator} />

            <div className="flex-1" />

            <div className="flex min-w-0 items-center gap-3.5">
              {showPermission && (
                <PermissionModeDropdown
                  currentMode={currentPermissionMode}
                  modes={visibleModes}
                  isOpen={permMenuOpen}
                  menuRef={permMenuRef}
                  onToggle={() => { closeAllPopups('perm'); setPermMenuOpen(!permMenuOpen) }}
                  onSelect={handlePermissionModeSelect}
                />
              )}
              {showWorktree && (
                <div className="flex">
                  {worktreePath ? (
                    <StateItem title={`In a worktree: ${worktreePath}`}>
                      <IconGitBranch size={14} stroke={2} className="text-primary-5" />
                      <StateLabel>
                        <span className="inline-block max-w-[140px] truncate align-bottom text-primary-5">{worktreePath.split('/').pop()}</span>
                      </StateLabel>
                    </StateItem>
                  ) : showWorktreeToggle && onWorktreeChange ? (
                    <StateItem
                      onClick={() => onWorktreeChange(!useWorktree)}
                      title={useWorktree
                        ? 'This session will start in a git worktree — click to use the repo directly'
                        : 'This session will run in the repo directly — click to use a git worktree'}
                    >
                      {useWorktree
                        ? <IconGitBranch size={14} stroke={2} className="text-primary-5" />
                        : <IconGitBranchDeleted size={14} stroke={2} />}
                      <StateLabel>
                        <span className={useWorktree ? 'text-primary-5' : undefined}>
                          {useWorktree ? 'Worktree' : 'No worktree'}
                        </span>
                      </StateLabel>
                    </StateItem>
                  ) : onMoveToWorktree ? (
                    <StateItem onClick={onMoveToWorktree} title="Not in a worktree — click to move this session into one">
                      <IconGitBranchDeleted size={14} stroke={2} />
                      <StateLabel>No worktree</StateLabel>
                    </StateItem>
                  ) : null}
                </div>
              )}
              {showModel && (
                <div className="flex">
                  <ModelDropdown
                    currentModel={currentModel}
                    models={availableModels}
                    isOpen={modelMenuOpen}
                    menuRef={modelMenuRef}
                    onToggle={() => { closeAllPopups('model'); setModelMenuOpen(!modelMenuOpen) }}
                    onChange={(id) => { onModelChange(id); setModelMenuOpen(false) }}
                  />
                </div>
              )}
            </div>

            <div className="flex items-center gap-1">
              {/* Overflow — carries the state items that collapsed */}
              {hasOverflow && (
                <div className="relative @[34rem]:hidden" ref={mobileMenuRef}>
                  <ToolbarAction onClick={() => setMobileMenuOpen(!mobileMenuOpen)} disabled={disabled} title="More options">
                    <IconDots className="density-icon" stroke={2} />
                  </ToolbarAction>
                  {mobileMenuOpen && (
                    <div className="absolute bottom-full mb-1 right-0 z-50 min-w-[220px] rounded-floating border border-edge-strong bg-surface-raised shadow-floating py-1">
                      {showWorktree && (
                        <>
                          <div className="px-3 py-1.5 text-meta text-ink-muted uppercase tracking-wider">Worktree</div>
                          {worktreePath ? (
                            <div className="px-3 py-2 text-body text-ink-muted truncate" title={worktreePath}>
                              {worktreePath.split('/').pop()}
                            </div>
                          ) : showWorktreeToggle && onWorktreeChange ? (
                            <button
                              onClick={() => { onWorktreeChange(!useWorktree); setMobileMenuOpen(false) }}
                              className="flex items-center gap-2 w-full text-left px-3 py-2 text-body text-ink hover:bg-edge transition-colors"
                            >
                              <IconGitBranch size={18} stroke={2} className={useWorktree ? 'text-primary-4' : 'text-ink-muted'} />
                              {useWorktree ? 'Worktree enabled' : 'Use a worktree'}
                              {useWorktree && <IconCheck size={14} stroke={2.5} className="ml-auto text-primary-4" />}
                            </button>
                          ) : onMoveToWorktree ? (
                            <button
                              onClick={() => { onMoveToWorktree(); setMobileMenuOpen(false) }}
                              className="flex items-center gap-2 w-full text-left px-3 py-2 text-body text-ink hover:bg-edge transition-colors"
                            >
                              <IconGitBranch size={18} stroke={2} className="text-ink-muted" />
                              Move to a worktree
                            </button>
                          ) : null}
                          {showModel && <div className="my-1 border-t border-edge-strong" />}
                        </>
                      )}
                      {showModel && (
                        <>
                          <div className="px-3 py-1.5 text-meta text-ink-muted uppercase tracking-wider">Model</div>
                          {availableModels.map(m => (
                            <button
                              key={m.id}
                              onClick={() => { onModelChange(m.id); setMobileMenuOpen(false) }}
                              className={`w-full text-left px-3 py-2 text-body hover:bg-edge transition-colors ${m.id === currentModel ? 'text-primary-4' : 'text-ink'}`}
                            >
                              {m.label}
                            </button>
                          ))}
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}

              {hasSkills && (
                <div className="relative">
                  <ToolbarAction
                    onClick={() => { closeAllPopups('skill'); setSkillMenuOpen(!skillMenuOpen) }}
                    disabled={disabled}
                    title="Claude Skills"
                  >
                    <IconTerminal2 className="density-icon" stroke={2} />
                  </ToolbarAction>
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

              <SendButton
                onClick={handleSend}
                disabled={disabled}
                hasContent={!!(value.trim() || pendingFiles.length > 0)}
                accent={isOrchestrator}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
})
