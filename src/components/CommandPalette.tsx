/**
 * Full-screen command palette (Ctrl+K) for quick navigation.
 *
 * Uses the cmdk library to provide fuzzy search across repos, skills,
 * modules, docs, archived sessions and actions (e.g. Settings). Results are
 * grouped by category with keyboard-navigable selection. Doc and archive
 * entries belonging to the active repo sort ahead of every other repo's.
 */

import { Command } from 'cmdk'
import { IconFileText, IconStarFilled, IconArchive } from '@tabler/icons-react'
import type { Repo, Skill, Module, DocsPickerProps } from '../types'
import type { ArchivedSessionInfo } from '../lib/ccApi'

/** The docs picker's file shape, reused so the palette stays in step with it. */
type DocsPickerFile = NonNullable<DocsPickerProps['files']>[number]

/**
 * A markdown doc as the palette needs it: the picker's file shape plus the
 * repo it belongs to and whether the user has starred it.
 */
export interface PaletteDoc extends Partial<DocsPickerFile> {
  path: string
  repoDir: string
  starred?: boolean
}

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
  /** Markdown docs across all repos; the active repo's sort first. */
  docs?: PaletteDoc[]
  /** Open a doc. Receives the repo-relative path and the repo's working dir. */
  onSelectDoc?: (path: string, repoDir: string) => void
  /** Archived sessions across all repos; the active repo's sort first. */
  archivedSessions?: ArchivedSessionInfo[]
  /** Open an archived session by id. */
  onSelectArchived?: (id: string) => void
  /** Working dir of the active repo — used to sort its entries first. */
  activeWorkingDir?: string | null
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/** Trailing path segment of a working dir, used as the repo's short name. */
function repoDisplayName(workingDir: string): string {
  const parts = workingDir.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || workingDir
}

/** Split a doc path into its directory (may be empty) and its filename. */
function splitDocPath(path: string): { dir: string; file: string } {
  const idx = path.lastIndexOf('/')
  if (idx === -1) return { dir: '', file: path }
  return { dir: path.slice(0, idx), file: path.slice(idx + 1) }
}

/**
 * SQLite `datetime('now')` returns 'YYYY-MM-DD HH:MM:SS' without a timezone —
 * treat it as UTC. Newer rows use unambiguous ISO 8601.
 */
function parseUtcDate(dateStr: string): Date {
  if (!dateStr.includes('T') && !dateStr.includes('Z') && !dateStr.includes('+')) {
    return new Date(dateStr.replace(' ', 'T') + 'Z')
  }
  return new Date(dateStr)
}

/** Compact relative age, e.g. "12m", "3h", "5d". */
function compactAge(dateStr: string): string {
  const seconds = Math.floor((Date.now() - parseUtcDate(dateStr).getTime()) / 1000)
  if (seconds < 60) return `${Math.max(seconds, 0)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** Archived sessions carry placeholder names for unnamed hub sessions. */
function archivedDisplayName(session: ArchivedSessionInfo): string {
  const name = session.name || session.id.slice(0, 8)
  return name.startsWith('hub:') ? 'unnamed session' : name
}

export function CommandPalette({ open, onClose, repos, globalSkills = [], globalModules = [], onOpenRepo, onSendSkill, onSendModule, onOpenSettings, isMobile = false, docs = [], onSelectDoc, archivedSessions = [], onSelectArchived, activeWorkingDir = null }: Props) {
  if (!open) return null

  // Active repo first, then starred, then pinned root files, then by path.
  const sortedDocs = onSelectDoc
    ? [...docs].sort((a, b) => {
        const aActive = a.repoDir === activeWorkingDir ? 0 : 1
        const bActive = b.repoDir === activeWorkingDir ? 0 : 1
        if (aActive !== bActive) return aActive - bActive
        const aStar = a.starred ? 0 : 1
        const bStar = b.starred ? 0 : 1
        if (aStar !== bStar) return aStar - bStar
        const aPin = a.pinned ? 0 : 1
        const bPin = b.pinned ? 0 : 1
        if (aPin !== bPin) return aPin - bPin
        return a.path.localeCompare(b.path)
      })
    : []

  // Active repo first, then most recently archived.
  const sortedArchived = onSelectArchived
    ? [...archivedSessions].sort((a, b) => {
        const aActive = a.workingDir === activeWorkingDir ? 0 : 1
        const bActive = b.workingDir === activeWorkingDir ? 0 : 1
        if (aActive !== bActive) return aActive - bActive
        return parseUtcDate(b.archivedAt).getTime() - parseUtcDate(a.archivedAt).getTime()
      })
    : []

  return (
    <div className={`fixed inset-0 z-50 flex bg-black/60 ${isMobile ? 'items-end' : 'items-start justify-center pt-[20vh]'}`} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className={`w-full ${isMobile ? '' : 'max-w-lg'}`}>
        <Command
          className="rounded-floating border border-edge-strong bg-surface-raised shadow-floating"
          label="Command palette"
        >
          <Command.Input
            placeholder="Search repos, skills, modules, docs, archive..."
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

            {/* cmdk keeps groups visible while the search is empty, so an
                unwired (or empty) collection must not render a group at all. */}
            {sortedDocs.length > 0 && (
            <Command.Group heading="Docs" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-meta [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-ink-muted">
              {sortedDocs.map(doc => {
                const { dir, file } = splitDocPath(doc.path)
                const repoName = repoDisplayName(doc.repoDir)
                return (
                  <Command.Item
                    key={`doc-${doc.repoDir}-${doc.path}`}
                    value={`doc ${file} ${dir} ${doc.path} ${repoName}`}
                    onSelect={() => { onSelectDoc?.(doc.path, doc.repoDir); onClose() }}
                    className="flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-body text-ink-muted aria-selected:bg-primary-8/20 aria-selected:text-primary-4"
                  >
                    {doc.starred
                      ? <IconStarFilled size={13} className="flex-shrink-0 text-primary-5" />
                      : <IconFileText size={13} className="flex-shrink-0 text-ink-faint" />}
                    <span className="truncate font-medium text-ink">{file}</span>
                    {dir && <span className="truncate font-mono text-meta text-ink-faint">{dir}</span>}
                    <span className="ml-auto flex-shrink-0 text-meta text-ink-muted">{repoName}</span>
                  </Command.Item>
                )
              })}
            </Command.Group>
            )}

            {sortedArchived.length > 0 && (
            <Command.Group heading="Archived sessions" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-meta [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-ink-muted">
              {sortedArchived.map(session => {
                const name = archivedDisplayName(session)
                const repoName = repoDisplayName(session.workingDir)
                return (
                  <Command.Item
                    key={`archived-${session.id}`}
                    value={`archived ${name} ${repoName} ${session.id}`}
                    onSelect={() => { onSelectArchived?.(session.id); onClose() }}
                    className="flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-body text-ink-muted aria-selected:bg-primary-8/20 aria-selected:text-primary-4"
                  >
                    <IconArchive size={13} className="flex-shrink-0 text-ink-faint" />
                    <span className="truncate text-ink">{name}</span>
                    <span className="ml-auto flex-shrink-0 text-meta text-ink-muted">{repoName} &middot; {compactAge(session.archivedAt)} ago</span>
                  </Command.Item>
                )
              })}
            </Command.Group>
            )}

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
