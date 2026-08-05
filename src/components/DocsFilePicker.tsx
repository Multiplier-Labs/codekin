/**
 * DocsFilePicker — the Docs tab's content renderer.
 *
 * Pure content: no header, no filter input, no scroll container, no close
 * button. `RepoDrawer` owns all of that and passes the filter string down.
 *
 * Ordering (task 08, item 10): starred first, then the pinned root files
 * (CLAUDE.md / README.md), then one group per folder. Rows lead with the
 * filename and demote the directory to a monospace suffix; grouped rows drop
 * the `.md` extension because every entry has it.
 */

import { useEffect, useMemo } from 'react'
import { IconLoader2, IconFileText, IconStar, IconStarFilled } from '@tabler/icons-react'

export interface DocFile {
  path: string
  pinned: boolean
}

interface Props {
  files: DocFile[]
  loading: boolean
  starredDocs: string[]
  onSelect: (filePath: string) => void
  /** Star/unstar a doc. Star buttons are hidden when omitted. */
  onToggleStar?: (filePath: string) => void
  /** Filter text owned by the drawer's filter row. */
  filter?: string
  /**
   * Legacy inline-sidebar usage only — binds Escape to close. The drawer owns
   * closing and does not pass this; drop it once no inline caller remains.
   */
  onClose?: () => void
}

/** Split "docs/setup/install.md" into ["docs/setup", "install.md"]. */
function splitPath(path: string): { dir: string; file: string } {
  const idx = path.lastIndexOf('/')
  if (idx === -1) return { dir: '', file: path }
  return { dir: path.slice(0, idx), file: path.slice(idx + 1) }
}

function stripMd(name: string): string {
  return name.replace(/\.md$/i, '')
}

export function DocsFilePicker({ files, loading, starredDocs, onSelect, onToggleStar, filter = '', onClose }: Props) {
  useEffect(() => {
    if (!onClose) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose?.()
    }
    document.addEventListener('keydown', handleKey)
    return () => { document.removeEventListener('keydown', handleKey) }
  }, [onClose])

  const starredSet = useMemo(() => new Set(starredDocs), [starredDocs])

  const { starred, pinned, folders } = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const visible = needle ? files.filter(f => f.path.toLowerCase().includes(needle)) : files

    const starredFiles = visible.filter(f => starredSet.has(f.path))
    const pinnedFiles = visible.filter(f => f.pinned && !starredSet.has(f.path))
    const rest = visible.filter(f => !f.pinned && !starredSet.has(f.path))

    const byFolder = new Map<string, DocFile[]>()
    for (const f of rest) {
      const { dir } = splitPath(f.path)
      const group = byFolder.get(dir)
      if (group) group.push(f)
      else byFolder.set(dir, [f])
    }
    // Root files first, then folders alphabetically.
    const folderEntries = [...byFolder.entries()].sort(([a], [b]) => {
      if (a === '') return -1
      if (b === '') return 1
      return a.localeCompare(b)
    })
    for (const [, group] of folderEntries) group.sort((a, b) => a.path.localeCompare(b.path))

    return { starred: starredFiles, pinned: pinnedFiles, folders: folderEntries }
  }, [files, filter, starredSet])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6">
        <IconLoader2 size={16} className="animate-spin text-ink-muted" />
      </div>
    )
  }

  if (files.length === 0) {
    return (
      <EmptyState
        title="No markdown in this repo"
        body="Docs lists every .md file under the repo root. Add a README.md or CLAUDE.md and it shows up here."
      />
    )
  }

  const matched = starred.length + pinned.length + folders.reduce((n, [, g]) => n + g.length, 0)
  if (matched === 0) {
    return (
      <EmptyState
        title="No matching docs"
        body={`Nothing in this repo matches "${filter.trim()}".`}
      />
    )
  }

  return (
    <div className="flex flex-col py-1">
      {starred.length > 0 && (
        <Section label="Starred">
          {starred.map(f => (
            <DocRow
              key={f.path}
              file={f}
              display={splitPath(f.path).file}
              starred
              onSelect={onSelect}
              onToggleStar={onToggleStar}
            />
          ))}
        </Section>
      )}

      {pinned.length > 0 && (
        <Section label="Repo files">
          {pinned.map(f => (
            <DocRow
              key={f.path}
              file={f}
              display={splitPath(f.path).file}
              starred={false}
              onSelect={onSelect}
              onToggleStar={onToggleStar}
            />
          ))}
        </Section>
      )}

      {folders.map(([dir, group]) => (
        <Section key={dir || '__root__'} label={dir || 'Root'}>
          {group.map(f => (
            <DocRow
              key={f.path}
              file={f}
              display={stripMd(splitPath(f.path).file)}
              starred={false}
              hideDir
              onSelect={onSelect}
              onToggleStar={onToggleStar}
            />
          ))}
        </Section>
      ))}
    </div>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-1">
      <div className="px-2 pt-1.5 pb-0.5 text-micro font-semibold uppercase tracking-wider text-ink-faint truncate" title={label}>
        {label}
      </div>
      {children}
    </div>
  )
}

function DocRow({ file, display, starred, hideDir = false, onSelect, onToggleStar }: {
  file: DocFile
  display: string
  starred: boolean
  hideDir?: boolean
  onSelect: (path: string) => void
  onToggleStar?: (path: string) => void
}) {
  const { dir } = splitPath(file.path)
  return (
    <div className="group density-row flex items-center gap-1 rounded-control px-1 transition-colors hover:bg-surface-raised">
      <button
        onClick={() => { onSelect(file.path) }}
        title={file.path}
        className="flex min-w-0 flex-1 items-baseline gap-2 rounded-control px-1 py-1 text-left"
      >
        <IconFileText size={13} className="shrink-0 self-center text-ink-faint" />
        <span className="truncate text-body font-medium text-ink">{display}</span>
        {!hideDir && dir && (
          <span className="shrink-0 truncate font-mono text-micro text-ink-faint">{dir}</span>
        )}
      </button>
      {onToggleStar && (
        <button
          onClick={() => { onToggleStar(file.path) }}
          title={starred ? 'Unstar' : 'Star'}
          aria-pressed={starred}
          className={`tap-target shrink-0 rounded-control p-1 transition-colors ${
            starred ? 'text-primary-5' : 'text-ink-faint opacity-0 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100'
          }`}
        >
          {starred ? <IconStarFilled size={13} /> : <IconStar size={13} />}
        </button>
      )}
    </div>
  )
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="px-4 py-8 text-center">
      <p className="text-body font-medium text-ink-muted">{title}</p>
      <p className="mt-1 text-meta text-ink-faint">{body}</p>
    </div>
  )
}
