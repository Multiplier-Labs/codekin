/**
 * Inline slash-command autocomplete popup.
 *
 * Triggered when the user types "/" at the start of the input. Uses cmdk
 * for fuzzy filtering and keyboard navigation. Positioned above the InputBar.
 */

import { useEffect, useRef, useCallback } from 'react'
import { Command } from 'cmdk'
import type { SlashCommand, SlashCommandCategory } from '../lib/slashCommands'

interface Props {
  commands: SlashCommand[]
  filter: string
  onSelect: (command: SlashCommand) => void
  onClose: () => void
}

const CATEGORY_BADGE: Record<SlashCommandCategory, { label: string; className: string }> = {
  skill: { label: 'skill', className: 'bg-accent-9/30 text-accent-5' },
  bundled: { label: 'built-in', className: 'bg-primary-9/30 text-primary-5' },
  builtin: { label: 'command', className: 'bg-neutral-8 text-neutral-4' },
}

const CATEGORY_ICON_CLASS: Record<SlashCommandCategory, string> = {
  skill: 'text-accent-6',
  bundled: 'text-primary-5',
  builtin: 'text-neutral-5',
}

export function SlashAutocomplete({ commands, filter, onSelect, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Close on click outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [onClose])

  const handleSelect = useCallback((value: string) => {
    const cmd = commands.find(c => c.command === value)
    if (cmd) onSelect(cmd)
  }, [commands, onSelect])

  return (
    <div
      ref={ref}
      className="absolute bottom-full left-0 mb-1 z-50 w-72"
    >
      <Command
        className="rounded-lg border border-neutral-10 bg-neutral-11 shadow-2xl"
        label="Slash commands"
        filter={(value, search) => {
          // Match against command name (without /) and display name
          const lower = search.toLowerCase()
          if (value.toLowerCase().includes(lower)) return 1
          return 0
        }}
      >
        {/* Hidden input — filter is controlled externally from the textarea */}
        <Command.Input
          value={filter}
          className="sr-only"
          aria-hidden
          tabIndex={-1}
          readOnly
        />
        <Command.List ref={listRef} className="max-h-64 overflow-y-auto p-1">
          <Command.Empty className="px-3 py-4 text-center text-[13px] text-neutral-5">
            No matching commands.
          </Command.Empty>

          {commands.map(cmd => {
            const badge = CATEGORY_BADGE[cmd.category]
            const iconClass = CATEGORY_ICON_CLASS[cmd.category]
            return (
              <Command.Item
                key={cmd.command}
                value={`${cmd.command.slice(1)} ${cmd.name}`}
                onSelect={() => handleSelect(cmd.command)}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[14px] text-neutral-3 aria-selected:bg-primary-8/20 aria-selected:text-primary-4"
              >
                <span className={`font-mono text-[13px] ${iconClass}`}>/</span>
                <span className="flex-1 truncate">
                  <span className="font-medium">{cmd.name}</span>
                  <span className="ml-1.5 text-[12px] text-neutral-5">{cmd.description}</span>
                </span>
                <span className={`flex-shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${badge.className}`}>
                  {badge.label}
                </span>
              </Command.Item>
            )
          })}
        </Command.List>
      </Command>
    </div>
  )
}
