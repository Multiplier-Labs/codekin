/**
 * Dropdown menu listing available slash-command skills.
 *
 * Skills are grouped by source (global vs. repo-specific). Selecting a
 * skill inserts its command (e.g. "/commit") into the input bar.
 * Dismisses on click-outside or Escape.
 */

import { useEffect, useRef } from 'react'
import type { Skill } from '../types'

export interface SkillGroup {
  label: string
  skills: Skill[]
}

interface Props {
  groups: SkillGroup[]
  onSelectSkill: (command: string) => void
  onClose: () => void
}

export function SkillMenu({ groups, onSelectSkill, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  const nonEmpty = groups.filter(g => g.skills.length > 0)
  if (nonEmpty.length === 0) return null

  return (
    <div
      ref={ref}
      className="absolute bottom-full right-0 mb-1 w-56 rounded-floating border border-edge-strong bg-surface-raised py-1 shadow-floating z-50"
    >
      <div className="px-3 py-1.5 text-body font-semibold text-ink border-b border-edge mb-1">
        Claude Skills
      </div>
      {nonEmpty.map((group, gi) => (
        <div key={group.label}>
          {gi > 0 && <div className="my-1 border-t border-edge" />}
          <div className="px-3 py-1 text-meta font-medium uppercase tracking-wider text-ink-muted">
            {group.label}
          </div>
          {group.skills.map(skill => (
            <button
              key={skill.id}
              onClick={() => onSelectSkill(skill.command)}
              className="flex w-full flex-col px-3 py-1.5 text-left hover:bg-edge transition-colors"
            >
              <span className="text-body font-medium text-accent-6">{skill.command}</span>
              {skill.description && (
                <span className="text-body text-ink-muted">{skill.description}</span>
              )}
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}
