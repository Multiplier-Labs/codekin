/**
 * Chat input bar with textarea, file attachment, skill menu, and
 * inline slash-command autocomplete.
 *
 * Supports Enter to send, Shift+Enter for newline, Shift+Tab to cycle the
 * enabled permission modes, Ctrl+C (nothing selected) to stop the agent's turn, Escape to blur. The textarea sizes itself to its content, from two lines up
 * to 40% of the pane; the toolbar below it is one row, split into session
 * state (left, unboxed monospace) and actions (right, exactly one filled).
 */

import { useState, useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react'
import { useOutsideClick } from '../hooks/useOutsideClick'
import { useAutoGrow } from '../hooks/useAutoGrow'
import { useAgentHealth } from '../hooks/useAgentHealth'
import { providerAvailability } from '../lib/agentHealth'
import { IconRobotFace, IconLock, IconPlus, IconX, IconTerminal2, IconChevronDown, IconChevronLeft, IconChevronRight, IconArrowRight, IconArrowsRightLeft, IconDots, IconGitBranch, IconGitBranchDeleted, IconShieldCheck, IconPencil, IconMap2, IconAlertTriangle, IconCheck, IconCornerDownLeft } from '@tabler/icons-react'
import { SkillMenu, type SkillGroup } from './SkillMenu'
import { SlashAutocomplete } from './SlashAutocomplete'
import { DropZone } from './DropZone'
import type { SlashCommand } from '../lib/slashCommands'
import { PERMISSION_MODES, PROVIDERS, effortLabel, permissionModesFor, type PermissionMode, type ModelOption } from '../types'
import { getPref, setPref, usePref } from '../lib/prefs'
import { composerTone, cycleCandidates, offeredModes, resolveEnabledModes } from '../lib/permissionModes'
import { CYCLE_EFFORT_KEYS, effectiveEffort, effortChoices, effortDisplay, isCycleEffortKey, nextEffort, rememberedEffort } from '../lib/effort'
import { isAddressedToJoe } from '../lib/joeAddress'

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
 * since the picker only accepts images, markdown and PDFs.
 */
function AttachButton({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <ToolbarAction onClick={onClick} disabled={disabled} title="Attach images, markdown or PDFs">
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
  // Error rather than warning: it matches the red corner the card wears in a
  // dangerous mode, and error-4 clears 4.5:1 in every theme on the card's own
  // surface where warning-4 doesn't (Light: 3.8:1).
  const tone = danger ? 'text-error-4' : 'text-ink-muted hover:text-ink'
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

/**
 * Shown above the composer each time a dangerous mode (bypassPermissions,
 * dangerouslySkipPermissions) is picked from the mode menu — Shift+Tab never
 * lands on them (see cycleCandidates). It says what the mode does and what the
 * red corner on the composer means. Not modal: the mode is already on, and the
 * note only explains it and offers the way back.
 */
function DangerModeNote({ label, onDismiss, onSwitchToDefault }: {
  label: string; onDismiss: () => void; onSwitchToDefault?: () => void
}) {
  return (
    <div
      role="dialog"
      aria-label={`${label} is on`}
      className="absolute right-0 bottom-full z-50 mb-3 flex w-[340px] max-w-full flex-col gap-2.5 rounded-floating border border-edge-strong bg-surface-raised px-4 py-3.5 shadow-floating"
    >
      <div className="flex items-center gap-2 text-body font-bold text-ink">
        <span aria-hidden="true" className="h-0.5 w-4 bg-error-6" />
        <span>{label} is on</span>
      </div>
      <p className="text-meta text-ink-muted">
        Every tool call — file writes, shell commands, web requests — runs without asking.
        The red corner stays on the composer while this mode is on.
      </p>
      <div className="flex items-center justify-end gap-3.5">
        {onSwitchToDefault && (
          <button type="button" onClick={onSwitchToDefault} className="text-meta text-ink-muted underline hover:text-ink">
            Switch to Default
          </button>
        )}
        <button type="button" onClick={onDismiss} className="rounded-control bg-primary-fill px-3.5 py-1.5 text-meta font-bold text-on-primary-fill hover:brightness-105">
          Got it
        </button>
      </div>
      <span aria-hidden="true" className="absolute right-[18px] -bottom-[6px] h-2.5 w-2.5 rotate-45 border-r border-b border-edge-strong bg-surface-raised" />
    </div>
  )
}

/** Desktop permission mode dropdown with full descriptions. */
function PermissionModeDropdown({ currentMode, modes, isOpen, menuRef, onToggle, onSelect, below = false, note }: {
  currentMode: PermissionMode; modes: typeof PERMISSION_MODES; isOpen: boolean
  menuRef: React.RefObject<HTMLDivElement | null>
  onToggle: () => void; onSelect: (mode: PermissionMode) => void
  /** Open the menu under the chip (the new-session composer sits near the top). */
  below?: boolean
  /** A line under the list (e.g. why a mode is missing for this agent). */
  note?: string
}) {
  const mode = PERMISSION_MODES.find(m => m.id === currentMode)
  const ModeIcon = PERMISSION_MODE_ICONS[mode?.icon ?? 'shield']
  return (
    <div className="relative" ref={menuRef}>
      <StateItem
        onClick={onToggle}
        title={mode?.dangerous
          ? `Permission mode: ${mode.label} — tools run without asking. That's what the red corner means. Click or press Shift+Tab to change mode.`
          : `Permission mode: ${mode?.label ?? currentMode} (Shift+Tab to switch)`}
        danger={!!mode?.dangerous}
      >
        <ModeIcon size={14} stroke={2} />
        <StateLabel>{mode?.label ?? currentMode}</StateLabel>
        <IconChevronDown size={12} stroke={2} className="opacity-70" />
      </StateItem>
      {isOpen && (
        <div className={`absolute ${below ? 'top-full mt-1' : 'bottom-full mb-1'} left-0 z-50 min-w-[260px] rounded-floating border border-edge-strong bg-surface-raised shadow-floating py-1`}>
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
          {note && <div className="border-t border-edge-strong px-3 pt-1.5 pb-1 text-meta text-ink-muted">{note}</div>}
        </div>
      )}
    </div>
  )
}

/** One spelling per harness, shared with the sidebar mark — see PROVIDERS. */
function providerLabel(provider: import('../types').CodingProvider): string {
  return PROVIDERS.find(p => p.id === provider)?.label ?? provider
}

/** Handoff pane — the other harnesses, plus the carry-context toggle. */
function HandoffPane({ current, targets, onBack, onSelect }: {
  current: import('../types').CodingProvider
  targets: typeof PROVIDERS
  onBack: () => void
  onSelect: (provider: import('../types').CodingProvider, carryContext: boolean) => void
}) {
  const health = useAgentHealth()
  const [carryContext, setCarryContext] = useState(() => getPref('handoffCarryContext') !== false)

  const toggleCarry = () => {
    const next = !carryContext
    setCarryContext(next)
    setPref('handoffCarryContext', next)
  }

  return (
    <>
      <div className="flex items-center gap-1.5 border-b border-edge-strong px-2 py-1.5">
        <button
          onClick={onBack}
          className="flex items-center gap-1 rounded-control px-1 py-0.5 text-meta text-ink-muted transition-colors hover:bg-edge hover:text-ink"
          title={`Back to ${providerLabel(current)} models`}
        >
          <IconChevronLeft size={14} stroke={2} />
          Back
        </button>
        <span className="ml-auto text-meta text-ink-muted">Hand off to</span>
      </div>
      <div className="py-1">
        {targets.filter(p => p.id !== current).map(p => {
          const { available, hint } = providerAvailability(health, p.id)
          return (
            <button
              key={p.id}
              disabled={!available}
              onClick={() => onSelect(p.id, carryContext)}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-body transition-colors ${
                available ? 'text-ink hover:bg-edge' : 'cursor-not-allowed text-ink-faint'
              }`}
              title={hint ?? undefined}
            >
              {p.label}
              {!available && <span className="truncate text-meta text-ink-faint">not installed</span>}
              <IconArrowRight size={14} stroke={2} className="ml-auto text-ink-faint" />
            </button>
          )
        })}
      </div>
      <div className="border-t border-edge-strong py-1">
        <button
          onClick={toggleCarry}
          className="flex w-full items-start gap-2 px-3 py-1.5 text-left transition-colors hover:bg-edge"
          title="Distill this session into a handoff and share it with the new agent"
        >
          <span className={`mt-0.5 flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-control border ${carryContext ? 'border-primary-4 bg-primary-4' : 'border-edge-strong'}`}>
            {carryContext && <IconCheck size={10} stroke={3} className="text-ink-inverse" />}
          </span>
          <span className="min-w-0">
            <span className="block text-body text-ink">Carry context</span>
            <span className="block text-meta text-ink-muted">Hand off this session's context to the new agent</span>
          </span>
        </button>
      </div>
    </>
  )
}

/**
 * Effort pane — the current model's levels. "Default" leads the list only for
 * models whose harness default is unknown (see lib/effort).
 */
function EffortPane({ model, harnessLabel, current, onBack, onSelect }: {
  model: ModelOption
  harnessLabel: string | null
  current: string | null
  onBack: () => void
  onSelect: (effort: string | null) => void
}) {
  const active = effectiveEffort(current, model)
  return (
    <>
      <div className="flex items-center gap-1.5 border-b border-edge-strong px-2 py-1.5">
        <button
          onClick={onBack}
          className="flex items-center gap-1 rounded-control px-1 py-0.5 text-meta text-ink-muted transition-colors hover:bg-edge hover:text-ink"
          title={harnessLabel ? `Back to ${harnessLabel} models` : 'Back to models'}
        >
          <IconChevronLeft size={14} stroke={2} />
          Back
        </button>
        <span className="ml-auto truncate text-meta text-ink-muted">Effort · {model.label}</span>
      </div>
      <div className="overflow-y-auto py-1">
        {effortChoices(model).map(choice => {
          const isActive = choice === active
          const description = choice === null
            ? `Let ${harnessLabel ?? 'the agent'} choose`
            : model.efforts?.find(e => e.id === choice)?.description
          return (
            <button
              key={choice ?? 'default'}
              onClick={() => onSelect(choice)}
              className="flex w-full items-start gap-2 px-3 py-1.5 text-left transition-colors hover:bg-edge"
            >
              <span className="min-w-0 flex-1">
                <span className={`block text-body ${isActive ? 'text-primary-4' : 'text-ink'}`}>
                  {choice === null ? 'Default' : effortLabel(choice)}
                  {choice !== null && choice === model.defaultEffort && <span className="ml-1.5 text-meta text-ink-muted">default</span>}
                </span>
                {description && <span className="block text-meta text-ink-muted">{description}</span>}
              </span>
              {isActive && <IconCheck size={14} stroke={2.5} className="mt-0.5 flex-shrink-0 text-primary-4" />}
            </button>
          )
        })}
      </div>
    </>
  )
}

/** A model in the picker, with the effort it runs at (or would start on) beside it. */
function ModelRow({ model, effort, isCurrent, isActive, buttonRef, onClick }: {
  model: ModelOption
  /** Effort to show: the session's for the current model, the remembered one otherwise. */
  effort: string | null
  isCurrent: boolean
  isActive: boolean
  buttonRef: (el: HTMLButtonElement | null) => void
  onClick: () => void
}) {
  return (
    <button
      ref={buttonRef}
      onClick={onClick}
      className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-body transition-colors ${isActive ? 'bg-edge' : 'hover:bg-edge'} ${isCurrent ? 'text-primary-4' : 'text-ink'}`}
    >
      <span className="truncate">{model.label}</span>
      {model.efforts?.length ? (
        <span className="flex-shrink-0 text-meta text-ink-muted">{effortDisplay(effort, model)}</span>
      ) : null}
    </button>
  )
}

/**
 * One control for both halves of "what is answering me": the harness and the
 * model it runs. The menu lists only the current harness's models — switching
 * harness is a session handoff, not a peer of picking a model, so it lives
 * behind a CTA that opens a second pane.
 */
function AgentDropdown({ provider, handoffTargets, currentModel, currentEffort, models, isOpen, menuRef, onToggle, onModelChange, onEffortChange, onProviderChange, pickProvider = false, below = false }: {
  provider?: import('../types').CodingProvider
  /**
   * Choose the agent directly (a session not started yet) instead of handing
   * a running session off to another agent.
   */
  pickProvider?: boolean
  /** Open the menu under the chip. */
  below?: boolean
  handoffTargets: typeof PROVIDERS
  currentModel?: string | null
  /** Session's reasoning effort (null = harness default). */
  currentEffort?: string | null
  models: ModelOption[]
  isOpen: boolean
  menuRef: React.RefObject<HTMLDivElement | null>
  onToggle: () => void
  onModelChange?: (model: string) => void
  /** Omit to hide the effort control. */
  onEffortChange?: (effort: string | null) => void
  onProviderChange?: (provider: import('../types').CodingProvider, carryContext: boolean) => void
}) {
  const health = useAgentHealth()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [showHandoff, setShowHandoff] = useState(false)
  const [showEffort, setShowEffort] = useState(false)
  const [prevIsOpen, setPrevIsOpen] = useState(isOpen)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  // Reset transient menu state when isOpen prop changes (React-recommended
  // "adjusting state based on props" pattern — no useEffect needed)
  if (isOpen !== prevIsOpen) {
    setPrevIsOpen(isOpen)
    setActiveIndex(0)
    setShowHandoff(false)
    setShowEffort(false)
  }

  const getRecents = (): string[] => {
    return getPref('recentModels') ?? []
  }

  const addRecent = (id: string) => {
    const next = getRecents().filter(m => m !== id)
    next.unshift(id)
    setPref('recentModels', next.slice(0, 5))
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

  const selectModel = (id: string) => {
    addRecent(id)
    onModelChange?.(id)
  }

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
      if (m) selectModel(m.id)
    }
  }

  const harnessLabel = provider ? providerLabel(provider) : null
  const modelLabel = currentModel ? shortModelLabel(currentModel, models) : null
  const canPickModel = !!onModelChange && models.length > 0
  const currentOption = currentModel ? models.find(m => m.id === currentModel) : undefined
  const canPickEffort = !!onEffortChange && !!currentOption?.efforts?.length
  // The chip names the level only when one is known — "Default" for a
  // harness that keeps its default to itself would just be noise there.
  const chipEffort = canPickEffort ? effectiveEffort(currentEffort, currentOption) : null
  const rowEffort = (m: ModelOption) => m.id === currentModel ? (currentEffort ?? null) : rememberedEffort(m)

  return (
    <div className="relative" ref={menuRef}>
      <StateItem
        onClick={onToggle}
        title={`${harnessLabel ?? 'Agent'}${modelLabel ? ` · ${modelLabel}` : ''}${chipEffort ? ` · ${effortLabel(chipEffort)} effort` : ''} — ${pickProvider ? 'choose the agent, model, or effort' : 'change model, effort, or hand off'}`}
      >
        {/* Harness and model are one fact, so they carry one tone — the
            separator included. StateItem's muted colour (and its hover
            brightening) reaches all three. */}
        {harnessLabel}
        {harnessLabel && modelLabel && <span>·</span>}
        {modelLabel}
        {chipEffort && <><span>·</span>{effortLabel(chipEffort)}</>}
        <IconChevronDown size={12} stroke={2} className="opacity-70" />
      </StateItem>
      {isOpen && (
        <div className={`absolute ${below ? 'top-full mt-1' : 'bottom-full mb-1'} right-0 z-50 flex max-h-[380px] w-[280px] flex-col rounded-floating border border-edge-strong bg-surface-raised shadow-floating`}>
          {pickProvider && onProviderChange && !showEffort && (
            <div className="border-b border-edge-strong py-1" role="group" aria-label="Agent">
              <div className="px-3 py-1 text-micro text-ink-muted">Agent</div>
              {handoffTargets.map(p => {
                const { available, hint } = providerAvailability(health, p.id)
                const isCurrent = p.id === provider
                return (
                  <button
                    key={p.id}
                    disabled={!available}
                    onClick={() => { if (!isCurrent) onProviderChange(p.id, false) }}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-body transition-colors ${
                      available ? 'text-ink hover:bg-edge' : 'cursor-not-allowed text-ink-muted'
                    }`}
                    title={hint ?? p.description}
                  >
                    <span className={isCurrent ? 'text-primary-4' : undefined}>{p.label}</span>
                    <span className="truncate text-meta text-ink-muted">{available ? p.description : 'not installed'}</span>
                    {isCurrent && <IconCheck size={14} stroke={2.5} className="ml-auto flex-shrink-0 text-primary-4" />}
                  </button>
                )
              })}
            </div>
          )}
          {showHandoff && provider && onProviderChange ? (
            <HandoffPane
              current={provider}
              targets={handoffTargets}
              onBack={() => setShowHandoff(false)}
              onSelect={onProviderChange}
            />
          ) : showEffort && canPickEffort && currentOption ? (
            <EffortPane
              model={currentOption}
              harnessLabel={harnessLabel}
              current={currentEffort ?? null}
              onBack={() => setShowEffort(false)}
              onSelect={(effort) => { onEffortChange?.(effort); setShowEffort(false) }}
            />
          ) : (
            <>
              {canPickModel && (
                <div className="border-b border-edge-strong p-2">
                  <input
                    autoFocus
                    value={query}
                    onChange={e => { setQuery(e.target.value); setActiveIndex(0) }}
                    onKeyDown={handleKeyDown}
                    placeholder={harnessLabel ? `Search ${harnessLabel} models...` : 'Search models...'}
                    className="w-full bg-edge-strong text-body px-2 py-1.5 rounded-control outline-none text-ink placeholder:text-ink-muted"
                  />
                </div>
              )}

              <div className="overflow-y-auto py-1">
                {!canPickModel && (
                  <div className="px-3 py-2 text-meta text-ink-muted">
                    No models available for {harnessLabel ?? 'this agent'}.
                  </div>
                )}
                {canPickModel && !query && recents.length > 0 && (
                  <div className="mb-1">
                    <div className="px-3 py-1 text-micro text-ink-muted">Recent</div>
                    {recents.map((id, idx) => {
                      const m = models.find(x => x.id === id)
                      if (!m) return null
                      const index = idx
                      return (
                        <ModelRow
                          key={m.id}
                          model={m}
                          effort={rowEffort(m)}
                          isCurrent={m.id === currentModel}
                          isActive={index === activeIndex}
                          buttonRef={el => { itemRefs.current[index] = el }}
                          onClick={() => selectModel(m.id)}
                        />
                      )
                    })}
                  </div>
                )}

                {canPickModel && (
                  <div>
                    {!query && (
                      <div className="px-3 py-1 text-micro text-ink-muted">
                        {harnessLabel ? `${harnessLabel} models` : 'All Models'}
                      </div>
                    )}
                    {allModelsFiltered.map((m, idx) => {
                      const baseIndex = (!query && recents.length > 0) ? recents.length : 0
                      const index = baseIndex + idx
                      return (
                        <ModelRow
                          key={m.id}
                          model={m}
                          effort={rowEffort(m)}
                          isCurrent={m.id === currentModel}
                          isActive={index === activeIndex}
                          buttonRef={el => { itemRefs.current[index] = el }}
                          onClick={() => selectModel(m.id)}
                        />
                      )
                    })}
                  </div>
                )}
              </div>

              {canPickEffort && currentOption && (
                <div className="border-t border-edge-strong p-1">
                  <button
                    onClick={() => setShowEffort(true)}
                    className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-body text-ink transition-colors hover:bg-edge"
                    title={`Reasoning effort for ${currentOption.label}`}
                  >
                    Effort
                    <span className="ml-auto text-ink-muted">{effortDisplay(currentEffort, currentOption)}</span>
                    <IconChevronRight size={14} stroke={2} className="flex-shrink-0 text-ink-muted opacity-70" />
                  </button>
                </div>
              )}

              {provider && onProviderChange && !pickProvider && (
                <div className="border-t border-edge-strong p-1">
                  <button
                    onClick={() => setShowHandoff(true)}
                    className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-body text-ink-muted transition-colors hover:bg-edge hover:text-ink"
                    title="Move this session to another coding agent"
                  >
                    <IconArrowsRightLeft size={14} stroke={2} className="flex-shrink-0" />
                    Hand off to another agent
                    <IconChevronRight size={14} stroke={2} className="ml-auto flex-shrink-0 opacity-70" />
                  </button>
                </div>
              )}

              {canPickEffort && (
                <div className="flex items-center justify-end gap-2 border-t border-edge-strong px-3 py-1.5 text-meta text-ink-muted">
                  <kbd className="rounded-control border border-edge-strong px-1.5 font-sans text-micro">{CYCLE_EFFORT_KEYS}</kbd>
                  Cycle effort
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** Imperative handle for programmatic text insertion (e.g. from skill menu). */
export interface InputBarHandle {
  insertText: (text: string) => void
}

/** `draft`: the composer of a session not created yet (agent picked, not handed off; menus open downward). */
export type InputBarVariant = 'default' | 'draft'

interface InputBarProps {
  /** Called with the raw text when the user sends a message (Enter key or send button). */
  onSendInput: (data: string) => void
  /** True when Claude is waiting for user input (prompt mode). */
  isWaiting: boolean
  /** When true, textarea and action buttons are disabled (e.g. no auth token). */
  disabled: boolean
  /** Called when the user presses Escape — parent uses this to deselect the session. */
  onEscape: () => void
  /**
   * Stop the agent's current turn. Pass it only while the agent is working:
   * Ctrl+C with no text selected then calls it. Otherwise Ctrl+C is left to
   * the browser (copy on Linux and Windows).
   */
  onInterrupt?: () => void
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
  /** Reasoning effort of the session (null = harness default). */
  currentEffort?: string | null
  /** Called when the user picks or cycles the effort level. Omit to hide the control. */
  onEffortChange?: (effort: string | null) => void
  /** Available models for the current provider. */
  availableModels?: ModelOption[]
  /** Coding provider of the active session — filters provider-specific permission modes. */
  sessionProvider?: import('../types').CodingProvider
  /** Called when the user switches the session's coding provider. Omit to hide the switcher. */
  onProviderChange?: (provider: import('../types').CodingProvider, carryContext: boolean) => void
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
  /** Visual variant — see InputBarVariant. */
  variant?: InputBarVariant
  /**
   * Agent Joe's display name. When set, a leading @Joe addresses Joe instead
   * of the coding agent, the recipient is shown before sending, and an Ask
   * Joe action is offered.
   */
  joeName?: string
  /** Why ordinary messages are paused (Joe controls the session); @Joe still sends. */
  lockedReason?: string
  /** Rendered in the toolbar after the attach button (the draft's place chip). */
  placeSlot?: React.ReactNode
  /** A line under the permission menu (draft: why Skip is missing for this agent). */
  permissionNote?: string
}

export const InputBar = forwardRef<InputBarHandle, InputBarProps>(function InputBar({ onSendInput, isWaiting, disabled, onEscape, onInterrupt, pendingFiles, onAddFiles, onRemoveFile, skillGroups, slashCommands, initialValue = '', onValueChange, currentModel, onModelChange, currentEffort = null, onEffortChange, availableModels = [], sessionProvider, onProviderChange, placeholder, isMobile = false, showWorktreeToggle = false, useWorktree = false, onWorktreeChange, currentPermissionMode, onPermissionModeChange, onMoveToWorktree, worktreePath, variant = 'default', joeName, lockedReason, placeSlot, permissionNote }, ref) {
  const isDraft = variant === 'draft'
  const enabledModes = resolveEnabledModes(usePref('enabledPermissionModes'))
  const providerModes = permissionModesFor(sessionProvider)
  const visibleModes = offeredModes(providerModes, enabledModes, currentPermissionMode)
  const tone = composerTone(currentPermissionMode)
  const [value, setValue] = useState(initialValue)
  const [skillMenuOpen, setSkillMenuOpen] = useState(false)
  const [agentMenuOpen, setAgentMenuOpen] = useState(false)
  const [permMenuOpen, setPermMenuOpen] = useState(false)
  /** The dangerous mode just picked from the menu, while its note is showing. */
  const [dangerNote, setDangerNote] = useState<PermissionMode | null>(null)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [slashMenuOpen, setSlashMenuOpen] = useState(false)

  /** Close all toolbar popups, optionally keeping one open. */
  const closeAllPopups = useCallback((except?: 'skill' | 'agent' | 'perm') => {
    if (except !== 'skill') setSkillMenuOpen(false)
    if (except !== 'agent') setAgentMenuOpen(false)
    if (except !== 'perm') setPermMenuOpen(false)
  }, [])
  const [slashFilter, setSlashFilter] = useState('')
  const mobileMenuRef = useRef<HTMLDivElement>(null)
  const permMenuRef = useRef<HTMLDivElement>(null)
  const agentMenuRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const prevWaiting = useRef(false)
  /** Set once the mode cycler exists; null when this composer has no mode control. */
  const cycleModeRef = useRef<(() => void) | null>(null)

  // Height follows content — no stored height, no drag handle.
  useAutoGrow(textareaRef, value)

  useImperativeHandle(ref, () => ({
    insertText(text: string) {
      setValue(text)
      setTimeout(() => textareaRef.current?.focus(), 0)
    },
  }))

  // A restored draft (e.g. text typed while a new session was starting) should
  // keep extending where it left off, not insert at the start.
  useEffect(() => {
    const el = textareaRef.current
    if (el && el.value) el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  // Auto-focus on waiting transition false → true (skip on mobile to avoid keyboard popup)
  useEffect(() => {
    if (isWaiting && !prevWaiting.current && !isMobile) {
      textareaRef.current?.focus()
    }
    prevWaiting.current = isWaiting
  }, [isWaiting, isMobile])

  // Refocus when the user comes back to the window, so it is ready for typing.
  // Only when nothing else holds focus, no dialog is open, and no text is selected
  // (focusing would drop a selection the user may be about to copy).
  useEffect(() => {
    if (isMobile) return
    const onReturn = () => {
      const el = textareaRef.current
      if (!el || el.disabled) return
      const active = document.activeElement
      if (active && active !== document.body && active !== el) return
      if (document.querySelector('[role="dialog"], [aria-modal="true"]')) return
      const selection = window.getSelection()
      if (selection && !selection.isCollapsed) return
      el.focus()
    }
    window.addEventListener('focus', onReturn)
    return () => { window.removeEventListener('focus', onReturn) }
  }, [isMobile])

  // Close dropdown menus on outside click
  useOutsideClick(mobileMenuRef, mobileMenuOpen, useCallback(() => setMobileMenuOpen(false), []))
  useOutsideClick(permMenuRef, permMenuOpen, useCallback(() => setPermMenuOpen(false), []))
  useOutsideClick(agentMenuRef, agentMenuOpen, useCallback(() => setAgentMenuOpen(false), []))

  // The recipient is decided by the text, and shown before sending.
  const toJoe = !!joeName && isAddressedToJoe(value, joeName)
  const blocked = !!lockedReason && !toJoe

  const handleSend = useCallback(() => {
    if (!value.trim() && pendingFiles.length === 0) return
    setDangerNote(null)
    if (blocked) return
    setSlashMenuOpen(false)
    onSendInput(value)
    setValue('')
    onValueChange?.('')
  }, [value, pendingFiles, onSendInput, onValueChange, blocked])

  /** Ask Joe: address the current text to Joe (or back to the coding agent). */
  const toggleJoe = useCallback(() => {
    if (!joeName) return
    const next = toJoe ? value.replace(/^\s*@\S+[,:]?\s*/, '') : `@${joeName} ${value.trimStart()}`
    setValue(next)
    onValueChange?.(next)
    setTimeout(() => textareaRef.current?.focus(), 0)
  }, [joeName, toJoe, value, onValueChange])

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

    if (e.key === 'Tab' && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && cycleModeRef.current) {
      e.preventDefault()
      cycleModeRef.current()
      return
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      // Don't send when slash menu is open — Enter selects the autocomplete item
      // (cmdk handles this internally via its own keydown)
      if (!slashMenuOpen) {
        e.preventDefault()
        handleSend()
      }
    } else if (e.key === 'c' && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && onInterrupt) {
      // With text selected, Ctrl+C copies; only an empty selection interrupts.
      const el = e.currentTarget
      if (el.selectionStart === el.selectionEnd) {
        e.preventDefault()
        onInterrupt()
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      textareaRef.current?.blur()
      onEscape()
    }
  }, [slashMenuOpen, handleSend, onInterrupt, onEscape])

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
    onPermissionModeChange?.(mode)
    setPermMenuOpen(false)
    const dangerous = PERMISSION_MODES.find(m => m.id === mode)?.dangerous
    setDangerNote(dangerous && mode !== currentPermissionMode ? mode : null)
  }, [onPermissionModeChange, currentPermissionMode])

  // The note belongs to the mode it explains: it goes as soon as the session
  // leaves that mode (Shift+Tab, the menu, or another client), on Escape, and
  // when a message is sent.
  const noteMode = dangerNote && dangerNote === currentPermissionMode ? PERMISSION_MODES.find(m => m.id === dangerNote) : undefined
  useEffect(() => {
    if (!noteMode) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDangerNote(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [noteMode])

  /** Shift+Tab: step to the next enabled safe mode (dangerous ones are menu-only). */
  const cyclePermissionMode = useCallback(() => {
    if (!currentPermissionMode || !onPermissionModeChange) return
    const next = cycleCandidates(providerModes, enabledModes, currentPermissionMode)[0] as (typeof providerModes)[number] | undefined
    if (next) onPermissionModeChange(next.id)
  }, [currentPermissionMode, onPermissionModeChange, providerModes, enabledModes])

  const hasSkills = skillGroups && skillGroups.some(g => g.skills.length > 0)
  const hasSlashCommands = slashCommands && slashCommands.length > 0

  // Session state (left) and actions (right).
  const showPermission = !!currentPermissionMode && !!onPermissionModeChange
  useEffect(() => {
    cycleModeRef.current = showPermission ? cyclePermissionMode : null
  }, [showPermission, cyclePermissionMode])
  const showModel = !!currentModel && !!onModelChange
  const showProvider = !!sessionProvider && !!onProviderChange
  // Harness and model read as one fact ("what is answering me"), so they share
  // one control; it appears as soon as either half is known.
  const showAgent = showModel || showProvider
  const effortModel = showModel && onEffortChange ? availableModels.find(m => m.id === currentModel) : undefined
  const canCycleEffort = !disabled && !!effortModel?.efforts?.length

  // Mod+Shift+E steps through the current model's effort levels from anywhere
  // in the app while this composer is mounted.
  useEffect(() => {
    if (!canCycleEffort || !onEffortChange) return
    const onKey = (e: KeyboardEvent) => {
      if (!isCycleEffortKey(e)) return
      e.preventDefault()
      onEffortChange(nextEffort(currentEffort, effortModel))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canCycleEffort, onEffortChange, currentEffort, effortModel])

  const showWorktree = !!worktreePath || (showWorktreeToggle && !!onWorktreeChange) || !!onMoveToWorktree
  // Anything beyond the permission chip folds into the overflow menu on a
  // narrow composer; a dangerous mode must stay visible at every width.
  const hasOverflow = showAgent || showWorktree

  return (
    <div className="app-input-bar @container relative flex flex-col">
      {/* Exactly the transcript row's padding, so the card's edges land on the
          prose edges at every width. Nothing here reads the pane width. */}
      <div className="px-4 pb-3 pt-1 @[32rem]:px-12">
        <div data-mode-tone={tone} className="composer-card relative mx-auto flex w-full min-w-0 max-w-[var(--measure)] flex-col gap-2 rounded-control border border-edge bg-surface pt-2.5 pr-3 pb-2 pl-3">
          <DropZone onUpload={onAddFiles} disabled={disabled} />

          {noteMode && (
            <DangerModeNote
              label={noteMode.label}
              onDismiss={() => { setDangerNote(null) }}
              onSwitchToDefault={providerModes.some(m => m.id === 'default') ? () => { setDangerNote(null); onPermissionModeChange?.('default') } : undefined}
            />
          )}

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

          {(toJoe || blocked) && (
            <div className={`flex items-center gap-1.5 text-meta ${toJoe ? 'text-accent-4' : 'text-ink-muted'}`} role="status">
              {toJoe ? <IconRobotFace size={14} stroke={2} /> : <IconLock size={14} stroke={2} />}
              {toJoe
                ? <span>To Agent {joeName} — the coding agent won't see this</span>
                : <span>{lockedReason} Start with @{joeName ?? 'Joe'} to message it.</span>}
            </div>
          )}

          <div className="flex gap-2">
            {isWaiting && (
              <span className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full animate-pulse bg-primary-5" />
            )}
            <textarea
              ref={textareaRef}
              rows={2}
              value={value}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              disabled={disabled}
              autoFocus={!isMobile}
              placeholder={placeholder ?? (isWaiting ? 'Type response...' : 'What do you want to build?')}
              // Mobile must stay 16px: font sizes under 16px trigger iOS Safari zoom-on-focus
              className={`composer-textarea field-sizing-content max-h-[40vh] w-full flex-1 resize-none bg-transparent ${isMobile ? 'text-[16px]' : 'text-body'} text-ink placeholder:text-ink-muted outline-none disabled:opacity-50 overflow-y-auto`}
            />
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/png,image/jpeg,image/gif,image/webp,text/markdown,.md,application/pdf,.pdf"
              onChange={handleFileChange}
              className="hidden"
            />
          </div>

          {/* One toolbar: attach on the left rail, state and actions on the
              right — the arrangement the reference composer uses.

              Below 34rem the worktree and agent items fold into the overflow
              menu (they are `hidden @[34rem]:flex`, its button `@[34rem]:hidden`)
              so each is reachable from exactly one place at any width. The
              permission chip stays out of that trade: it is icon-only, and a
              dangerous mode must be visible everywhere. */}
          <div className="flex items-center gap-3">
            <AttachButton onClick={handleFileSelect} disabled={disabled} />
            {placeSlot}

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
                  below={isDraft}
                  note={permissionNote}
                />
              )}
              {showWorktree && (
                <div className="hidden @[34rem]:flex">
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
              {showAgent && (
                <div className="hidden @[34rem]:flex">
                  <AgentDropdown
                    provider={showProvider ? sessionProvider : undefined}
                    handoffTargets={PROVIDERS}
                    currentModel={showModel ? currentModel : null}
                    currentEffort={currentEffort}
                    models={availableModels}
                    isOpen={agentMenuOpen}
                    menuRef={agentMenuRef}
                    onToggle={() => { closeAllPopups('agent'); setAgentMenuOpen(!agentMenuOpen) }}
                    onModelChange={showModel ? (id) => { onModelChange(id); setAgentMenuOpen(false) } : undefined}
                    onEffortChange={showModel ? onEffortChange : undefined}
                    onProviderChange={showProvider ? (provider, carryContext) => { onProviderChange(provider, carryContext); setAgentMenuOpen(false) } : undefined}
                    pickProvider={isDraft}
                    below={isDraft}
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
                    <div className={`absolute ${isDraft ? 'top-full mt-1' : 'bottom-full mb-1'} right-0 z-50 min-w-[220px] rounded-floating border border-edge-strong bg-surface-raised shadow-floating py-1`}>
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
                          {showAgent && <div className="my-1 border-t border-edge-strong" />}
                        </>
                      )}
                      {showModel && (
                        <>
                          <div className="px-3 py-1.5 text-meta text-ink-muted uppercase tracking-wider">
                            {sessionProvider ? `${providerLabel(sessionProvider)} model` : 'Model'}
                          </div>
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
                      {showProvider && (
                        <>
                          {showModel && <div className="my-1 border-t border-edge-strong" />}
                          <div className="px-3 py-1.5 text-meta text-ink-muted uppercase tracking-wider">{isDraft ? 'Agent' : 'Hand off to'}</div>
                          {PROVIDERS.filter(p => p.id !== sessionProvider).map(p => (
                            <button
                              key={p.id}
                              onClick={() => {
                                onProviderChange(p.id, getPref('handoffCarryContext') !== false)
                                setMobileMenuOpen(false)
                              }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-body text-ink transition-colors hover:bg-edge"
                            >
                              {p.label}
                              <IconArrowRight size={14} stroke={2} className="ml-auto text-ink-faint" />
                            </button>
                          ))}
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}

              {joeName && (
                <ToolbarAction
                  onClick={toggleJoe}
                  disabled={disabled}
                  title={toJoe ? `Send to the coding agent instead` : `Ask Agent ${joeName}`}
                  accent
                >
                  <IconRobotFace className={`density-icon ${toJoe ? 'text-accent-4' : ''}`} stroke={2} />
                </ToolbarAction>
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
                disabled={disabled || blocked}
                hasContent={!!(value.trim() || pendingFiles.length > 0)}
                accent={toJoe}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
})
