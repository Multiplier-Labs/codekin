/**
 * Full-screen command palette (Ctrl+K) for quick navigation.
 *
 * Uses the cmdk library to provide fuzzy search across repos, skills,
 * modules, and actions (e.g. Settings). Results are
 * grouped by category with keyboard-navigable selection.
 */

import { Command } from 'cmdk'
import type { Repo, Skill, Module } from '../types'

interface Props {
  open: boolean
  onClose: () => void
  repos: Repo[]
  globalSkills?: Skill[]
  globalModules?: Module[]
  onOpenRepo: (repo: Repo) => void
  onSendSkill: (command: string) => void
  onSendModule: (module: Module) => void
  onOpenSettings: () => void
}

export function CommandPalette({ open, onClose, repos, globalSkills = [], globalModules = [], onOpenRepo, onSendSkill, onSendModule, onOpenSettings }: Props) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] bg-black/60" onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="w-full max-w-lg">
        <Command
          className="rounded-lg border border-neutral-10 bg-neutral-11 shadow-2xl"
          label="Command palette"
        >
          <Command.Input
            placeholder="Search repos, skills, modules, actions..."
            className="w-full border-b border-neutral-10 bg-transparent px-4 py-3 text-[15px] text-neutral-2 outline-none placeholder:text-neutral-5"
            autoFocus
          />
          <Command.List className="max-h-72 overflow-y-auto p-2">
            <Command.Empty className="px-4 py-8 text-center text-[15px] text-neutral-5">
              No results found.
            </Command.Empty>

            <Command.Group heading="Repos" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[12px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-neutral-5">
              {repos.map(repo => (
                <Command.Item
                  key={repo.id}
                  value={`repo ${repo.name} ${repo.tags.join(' ')}`}
                  onSelect={() => { onOpenRepo(repo); onClose() }}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[15px] text-neutral-4 aria-selected:bg-primary-8/20 aria-selected:text-primary-4"
                >
                  <span className="text-neutral-5">&#9634;</span>
                  {repo.name}
                  <span className="ml-auto text-[12px] text-neutral-5">{repo.tags.join(', ')}</span>
                </Command.Item>
              ))}
            </Command.Group>

            <Command.Group heading="Skills" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[12px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-neutral-5">
              {globalSkills.map(skill => (
                <Command.Item
                  key={`global-${skill.id}`}
                  value={`skill ${skill.name} ${skill.command} global`}
                  onSelect={() => { onSendSkill(skill.command); onClose() }}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[15px] text-neutral-4 aria-selected:bg-primary-8/20 aria-selected:text-primary-4"
                >
                  <span className="text-accent-6">/</span>
                  <span>{skill.name}</span>
                  <span className="ml-auto text-[12px] text-neutral-5">global</span>
                </Command.Item>
              ))}
              {repos.flatMap(repo =>
                repo.skills.map(skill => (
                  <Command.Item
                    key={`${repo.id}-${skill.id}`}
                    value={`skill ${skill.name} ${skill.command} ${repo.name}`}
                    onSelect={() => { onSendSkill(skill.command); onClose() }}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[15px] text-neutral-4 aria-selected:bg-primary-8/20 aria-selected:text-primary-4"
                  >
                    <span className="text-accent-6">/</span>
                    <span>{skill.name}</span>
                    <span className="ml-auto text-[12px] text-neutral-5">{repo.name}</span>
                  </Command.Item>
                )),
              )}
            </Command.Group>

            <Command.Group heading="Modules" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[12px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-neutral-5">
              {globalModules.map(mod => (
                <Command.Item
                  key={`module-${mod.id}`}
                  value={`module ${mod.name} ${mod.description} global`}
                  onSelect={() => { onSendModule(mod); onClose() }}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[15px] text-neutral-4 aria-selected:bg-primary-8/20 aria-selected:text-primary-4"
                >
                  <span className="text-primary-6">&#9670;</span>
                  <span>{mod.name}</span>
                  <span className="ml-auto text-[12px] text-neutral-5">global</span>
                </Command.Item>
              ))}
            </Command.Group>

            <Command.Group heading="Actions" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[12px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-neutral-5">
              <Command.Item
                value="settings token configure"
                onSelect={() => { onOpenSettings(); onClose() }}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[15px] text-neutral-4 aria-selected:bg-primary-8/20 aria-selected:text-primary-4"
              >
                <span className="text-neutral-5">&#9881;</span>
                Settings
              </Command.Item>
            </Command.Group>
          </Command.List>
        </Command>
      </div>
    </div>
  )
}
