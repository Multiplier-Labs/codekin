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
      className="absolute bottom-full right-0 mb-2 w-56 rounded-md border border-neutral-10 bg-neutral-12 py-1 shadow-lg z-50"
    >
      <div className="px-3 py-1.5 text-[13px] font-semibold text-neutral-3 border-b border-neutral-10 mb-1">
        Claude Skills
      </div>
      {nonEmpty.map((group, gi) => (
        <div key={group.label}>
          {gi > 0 && <div className="my-1 border-t border-neutral-10" />}
          <div className="px-3 py-1 text-[12px] font-medium uppercase tracking-wider text-neutral-5">
            {group.label}
          </div>
          {group.skills.map(skill => (
            <button
              key={skill.id}
              onClick={() => onSelectSkill(skill.command)}
              className="flex w-full flex-col px-3 py-1.5 text-left hover:bg-neutral-10/50"
            >
              <span className="text-[15px] font-medium text-accent-6">{skill.command}</span>
              {skill.description && (
                <span className="text-[13px] text-neutral-4">{skill.description}</span>
              )}
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}
