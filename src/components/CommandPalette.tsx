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
  isMobile?: boolean
}

export function CommandPalette({ open, onClose, repos, globalSkills = [], globalModules = [], onOpenRepo, onSendSkill, onSendModule, onOpenSettings, isMobile = false }: Props) {
  if (!open) return null

  return (
    <div className={`fixed inset-0 z-50 flex bg-black/60 ${isMobile ? 'items-end' : 'items-start justify-center pt-[20vh]'}`} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className={`w-full ${isMobile ? '' : 'max-w-lg'}`}>
        <Command
          className="rounded-floating border border-edge-strong bg-surface-raised shadow-floating"
          label="Command palette"
        >
          <Command.Input
            placeholder="Search repos, skills, modules, actions..."
            className="w-full border-b border-edge bg-transparent px-4 py-3 text-body text-ink outline-none placeholder:text-ink-muted"
            autoFocus
          />
          <Command.List className="max-h-72 overflow-y-auto p-2">
            <Command.Empty className="px-4 py-8 text-center text-body text-ink-muted">
              No results found.
            </Command.Empty>

            <Command.Group heading="Repos" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-meta [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-ink-muted">
              {repos.map(repo => (
                <Command.Item
                  key={repo.id}
                  value={`repo ${repo.name} ${repo.tags.join(' ')}`}
                  onSelect={() => { onOpenRepo(repo); onClose() }}
                  className="flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-body text-ink-muted aria-selected:bg-primary-8/20 aria-selected:text-primary-4"
                >
                  <span className="text-ink-muted">&#9634;</span>
                  {repo.name}
                  <span className="ml-auto text-meta text-ink-muted">{repo.tags.join(', ')}</span>
                </Command.Item>
              ))}
            </Command.Group>

            <Command.Group heading="Skills" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-meta [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-ink-muted">
              {globalSkills.map(skill => (
                <Command.Item
                  key={`global-${skill.id}`}
                  value={`skill ${skill.name} ${skill.command} global`}
                  onSelect={() => { onSendSkill(skill.command); onClose() }}
                  className="flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-body text-ink-muted aria-selected:bg-primary-8/20 aria-selected:text-primary-4"
                >
                  <span className="text-accent-6">/</span>
                  <span>{skill.name}</span>
                  <span className="ml-auto text-meta text-ink-muted">global</span>
                </Command.Item>
              ))}
              {repos.flatMap(repo =>
                repo.skills.map(skill => (
                  <Command.Item
                    key={`${repo.id}-${skill.id}`}
                    value={`skill ${skill.name} ${skill.command} ${repo.name}`}
                    onSelect={() => { onSendSkill(skill.command); onClose() }}
                    className="flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-body text-ink-muted aria-selected:bg-primary-8/20 aria-selected:text-primary-4"
                  >
                    <span className="text-accent-6">/</span>
                    <span>{skill.name}</span>
                    <span className="ml-auto text-meta text-ink-muted">{repo.name}</span>
                  </Command.Item>
                )),
              )}
            </Command.Group>

            <Command.Group heading="Modules" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-meta [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-ink-muted">
              {globalModules.map(mod => (
                <Command.Item
                  key={`module-${mod.id}`}
                  value={`module ${mod.name} ${mod.description} global`}
                  onSelect={() => { onSendModule(mod); onClose() }}
                  className="flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-body text-ink-muted aria-selected:bg-primary-8/20 aria-selected:text-primary-4"
                >
                  <span className="text-primary-6">&#9670;</span>
                  <span>{mod.name}</span>
                  <span className="ml-auto text-meta text-ink-muted">global</span>
                </Command.Item>
              ))}
            </Command.Group>

            <Command.Group heading="Actions" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-meta [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-ink-muted">
              <Command.Item
                value="settings token configure"
                onSelect={() => { onOpenSettings(); onClose() }}
                className="flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-body text-ink-muted aria-selected:bg-primary-8/20 aria-selected:text-primary-4"
              >
                <span className="text-ink-muted">&#9881;</span>
                Settings
              </Command.Item>
            </Command.Group>
          </Command.List>
        </Command>
      </div>
    </div>
  )
}
