/**
 * The composer's agent picker: one chip for the harness, its model and
 * reasoning effort (and, on a running session, its permission mode), with a
 * menu that searches models and opens panes for effort, permissions and
 * handing the session off to another agent.
 */

import { useState, useRef, useEffect } from 'react'
import { IconChevronDown, IconChevronLeft, IconChevronRight, IconArrowRight, IconArrowsRightLeft, IconCheck } from '@tabler/icons-react'
import { useAgentHealth } from '../hooks/useAgentHealth'
import { providerAvailability } from '../lib/agentHealth'
import { PERMISSION_MODE_ICONS } from '../lib/approvalGroups'
import { getPref, setPref } from '../lib/prefs'
import { CYCLE_EFFORT_KEYS, effectiveEffort, effortChoices, effortDisplay, rememberedEffort } from '../lib/effort'
import { PERMISSION_MODES, PROVIDERS, effortLabel, providerLabel, type CodingProvider, type PermissionMode, type ModelOption } from '../types'
import { StateItem } from './ComposerStateItem'

function shortModelLabel(modelId: string, models: ModelOption[]): string {
  return models.find(m => m.id === modelId)?.label ?? modelId.replace(/^claude-/, '')
}

/** Handoff pane — the other harnesses, plus the carry-context toggle. */
function HandoffPane({ current, targets, onBack, onSelect }: {
  current: CodingProvider
  targets: typeof PROVIDERS
  onBack: () => void
  onSelect: (provider: CodingProvider, carryContext: boolean) => void
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
export function AgentDropdown({ provider, handoffTargets, currentModel, currentEffort, models, isOpen, menuRef, onToggle, onModelChange, onEffortChange, onProviderChange, pickProvider = false, below = false, permission }: {
  provider?: CodingProvider
  /**
   * The session chip (a running session's composer): the chip also carries
   * the permission mode, changed from a row in this menu. A dangerous mode
   * shows on the chip itself at every width.
   */
  permission?: { current: PermissionMode; modes: typeof PERMISSION_MODES; onSelect: (mode: PermissionMode) => void }
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
  onProviderChange?: (provider: CodingProvider, carryContext: boolean) => void
}) {
  const health = useAgentHealth()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [showHandoff, setShowHandoff] = useState(false)
  const [showEffort, setShowEffort] = useState(false)
  const [showPermissions, setShowPermissions] = useState(false)
  const [prevIsOpen, setPrevIsOpen] = useState(isOpen)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  // Reset transient menu state when isOpen prop changes (React-recommended
  // "adjusting state based on props" pattern — no useEffect needed)
  if (isOpen !== prevIsOpen) {
    setPrevIsOpen(isOpen)
    setActiveIndex(0)
    setShowHandoff(false)
    setShowEffort(false)
    setShowPermissions(false)
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
  const mode = permission ? PERMISSION_MODES.find(m => m.id === permission.current) : undefined
  const ModeIcon = PERMISSION_MODE_ICONS[mode?.icon ?? 'shield']
  const dangerous = !!mode?.dangerous

  return (
    <div className="relative min-w-0" ref={menuRef}>
      <StateItem
        onClick={onToggle}
        danger={dangerous}
        title={`${harnessLabel ?? 'Agent'}${modelLabel ? ` · ${modelLabel}` : ''}${chipEffort ? ` · ${effortLabel(chipEffort)} effort` : ''}${mode ? ` · Permission mode: ${mode.label}${dangerous ? ' — tools run without asking' : ''}` : ''} — ${pickProvider ? 'choose the agent, model, or effort' : permission ? 'change model, effort, permissions, or hand off (Shift+Tab cycles permissions)' : 'change model, effort, or hand off'}`}
      >
        {mode && <ModeIcon size={14} stroke={2} className="shrink-0" />}
        {/* A dangerous mode is named on the chip at every width (short form). */}
        {dangerous && mode && <><span className="shrink-0">{mode.id === 'bypassPermissions' ? 'Bypass' : 'Skip'}</span><span>·</span></>}
        {/* Harness and model are one fact, so they carry one tone — the
            separator included. StateItem's muted colour (and its hover
            brightening) reaches all three. The session chip leaves the
            harness to its title: the sidebar row already names it. */}
        <span className="min-w-0 truncate">
          {!permission && harnessLabel}
          {!permission && harnessLabel && modelLabel && ' · '}
          {modelLabel ?? (permission ? harnessLabel : null)}
          {chipEffort && ` · ${effortLabel(chipEffort)}`}
        </span>
        <IconChevronDown size={12} stroke={2} className="shrink-0 opacity-70" />
      </StateItem>
      {isOpen && (
        // A menu that opens downward (the start view) has the screen below it,
        // so it may run taller and show more of the model list.
        <div className={`absolute ${below ? 'top-full mt-1 max-h-[min(520px,70vh)]' : 'bottom-full mb-1 max-h-[380px]'} right-0 z-50 flex ${pickProvider ? 'w-[340px]' : 'w-[280px]'} flex-col rounded-floating border border-edge-strong bg-surface-raised shadow-floating`}>
          {pickProvider && onProviderChange && !showEffort && (
            // One segmented row, not a row per agent: the agents are few and
            // fixed, the models are what the menu is for, and they need the room.
            <div className="flex-shrink-0 border-b border-edge-strong p-2">
              <div role="radiogroup" aria-label="Agent" className="flex gap-0.5 rounded-control border border-edge-strong p-0.5">
                {handoffTargets.map(p => {
                  const { available, hint } = providerAvailability(health, p.id)
                  const isCurrent = p.id === provider
                  return (
                    <button
                      key={p.id}
                      role="radio"
                      aria-checked={isCurrent}
                      disabled={!available}
                      onClick={() => { if (!isCurrent) onProviderChange(p.id, false) }}
                      className={`min-w-0 flex-1 truncate rounded-control px-1.5 py-1 text-meta transition-colors ${
                        isCurrent
                          ? 'bg-edge-strong text-ink'
                          : available ? 'text-ink-muted hover:bg-edge hover:text-ink' : 'cursor-not-allowed text-ink-faint'
                      }`}
                      title={hint ?? (available ? p.description : `${p.label} is not installed`)}
                    >
                      {p.label}
                    </button>
                  )
                })}
              </div>
              {provider && (() => {
                // The chosen agent's CLI, or why it may not answer (not signed in).
                const hint = providerAvailability(health, provider).hint
                const text = hint ?? handoffTargets.find(p => p.id === provider)?.description
                return text ? (
                  <div className={`mt-1.5 truncate px-1 text-micro ${hint ? 'text-warning-5' : 'text-ink-muted'}`} title={text}>{text}</div>
                ) : null
              })()}
            </div>
          )}
          {showPermissions && permission ? (
            <div className="min-h-0 flex-1 overflow-y-auto py-1" role="menu" aria-label="Permission mode">
              <button
                onClick={() => setShowPermissions(false)}
                className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-meta text-ink-muted hover:text-ink"
              >
                <IconChevronLeft size={14} stroke={2} /> Permissions
              </button>
              {permission.modes.map(m => {
                const Icon = PERMISSION_MODE_ICONS[m.icon]
                const isActive = m.id === permission.current
                return (
                  <button
                    key={m.id}
                    role="menuitemradio"
                    aria-checked={isActive}
                    onClick={() => { permission.onSelect(m.id) }}
                    className={`flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors hover:bg-edge ${m.dangerous ? 'hover:bg-error-9/20' : ''}`}
                  >
                    <Icon size={16} stroke={2} className={`mt-0.5 flex-shrink-0 ${m.dangerous ? 'text-error-5' : isActive ? 'text-primary-4' : 'text-ink-muted'}`} />
                    <div className="min-w-0 flex-1">
                      <div className={`text-body font-medium ${m.dangerous ? 'text-error-5' : isActive ? 'text-primary-4' : 'text-ink'}`}>{m.label}</div>
                      <div className={`text-meta ${m.dangerous ? 'text-error-6' : 'text-ink-muted'}`}>{m.description}</div>
                    </div>
                    {isActive && <IconCheck size={14} stroke={2.5} className="mt-0.5 flex-shrink-0 text-primary-4" />}
                  </button>
                )
              })}
            </div>
          ) : showHandoff && provider && onProviderChange ? (
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
                <div className="flex-shrink-0 border-b border-edge-strong p-2">
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

              <div className="min-h-0 flex-1 overflow-y-auto py-1">
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
                <div className="flex-shrink-0 border-t border-edge-strong p-1">
                  <button
                    onClick={() => setShowEffort(true)}
                    className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-body text-ink transition-colors hover:bg-edge"
                    title={`Reasoning effort for ${currentOption.label} — ${CYCLE_EFFORT_KEYS} cycles it`}
                  >
                    Effort
                    {/* The shortcut sits on the row it drives, not in a footer of its own. */}
                    <kbd className="rounded-control border border-edge-strong px-1.5 font-sans text-micro text-ink-muted">{CYCLE_EFFORT_KEYS}</kbd>
                    <span className="ml-auto text-ink-muted">{effortDisplay(currentEffort, currentOption)}</span>
                    <IconChevronRight size={14} stroke={2} className="flex-shrink-0 text-ink-muted opacity-70" />
                  </button>
                </div>
              )}

              {permission && mode && (
                <div className="flex-shrink-0 border-t border-edge-strong p-1">
                  <button
                    onClick={() => setShowPermissions(true)}
                    className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-body text-ink transition-colors hover:bg-edge"
                    title="How tools are approved in this session — Shift+Tab cycles"
                  >
                    Permissions
                    <kbd className="rounded-control border border-edge-strong px-1.5 font-sans text-micro text-ink-muted">⇧Tab</kbd>
                    <span className={`ml-auto flex min-w-0 items-center gap-1 truncate ${dangerous ? 'text-error-5' : 'text-ink-muted'}`}>
                      <ModeIcon size={14} stroke={2} className="flex-shrink-0" />{mode.label}
                    </span>
                    <IconChevronRight size={14} stroke={2} className="flex-shrink-0 text-ink-muted opacity-70" />
                  </button>
                </div>
              )}

              {provider && onProviderChange && !pickProvider && (
                <div className="flex-shrink-0 border-t border-edge-strong p-1">
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
            </>
          )}
        </div>
      )}
    </div>
  )
}
