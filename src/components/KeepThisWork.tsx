/**
 * KeepThisWork — the "Keep this work?" callout on a scratch session.
 *
 * Shown once the scratch folder holds something and a turn has finished.
 * Promotion is offered, never required: **Make it a git repo**, **Publish to
 * GitHub…** (owner, name and visibility inline), and **Not now**, which is
 * remembered per session. Scratch folders are never deleted automatically,
 * so the callout makes no such claim.
 */

import { useState } from 'react'
import { IconCloudUpload, IconFolderShare, IconGitBranch } from '@tabler/icons-react'
import type { SessionPlace } from '../types'
import { FolderPicker } from './FolderPicker'

export interface PublishChoice {
  owner: string
  name: string
  visibility: 'private' | 'public'
}

interface Props {
  place: SessionPlace
  /** Folder name, the default repository name. */
  folderName: string
  /** GitHub owners the machine's gh login can create repositories under. */
  owners: string[]
  onGitInit: () => Promise<void>
  onPublish: (choice: PublishChoice) => Promise<string>
  /** Move the folder into a chosen parent. */
  onMove?: (parent: string) => Promise<void>
  /** For the folder browser. */
  token?: string
  onDismiss: () => void
}

const BTN = 'flex items-center gap-1.5 rounded-control border border-edge-strong px-2.5 py-1 text-meta text-ink hover:border-focus disabled:opacity-50'
const INPUT = 'rounded-control border border-edge bg-page px-2 py-1 text-meta text-ink focus:border-focus'

export function KeepThisWork({ place, folderName, owners, onGitInit, onPublish, onMove, token, onDismiss }: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [moving, setMoving] = useState(false)
  const [parent, setParent] = useState('')
  const [owner, setOwner] = useState(owners[0] ?? '')
  const [name, setName] = useState(folderName)
  const [visibility, setVisibility] = useState<'private' | 'public'>('private')
  const [published, setPublished] = useState<string | null>(null)

  const run = (label: string, action: () => Promise<unknown>) => {
    setBusy(label)
    setError(null)
    void action()
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)) })
      .finally(() => { setBusy(null) })
  }

  return (
    <div className="mx-3 mb-2 rounded-control border border-edge border-l-2 border-l-accent-6 bg-surface px-4 py-3" role="region" aria-label="Keep this work?">
      <div className="text-body font-medium text-ink">Keep this work?</div>
      <p className="mt-0.5 text-meta text-ink-muted">
        {published
          ? <>Published to <a href={published} target="_blank" rel="noopener noreferrer" className="text-primary-5 hover:underline">{published}</a>. It still lives in a scratch folder.</>
          : 'It lives in a scratch folder.'}
      </p>
      {moving && onMove ? (
        <div className="mt-2 flex flex-col gap-2">
          <FolderPicker
            value=""
            token={token}
            placeholder="~/projects"
            helpText={`The folder keeps its name: ${parent ? `${parent.replace(/\/+$/, '')}/${folderName}` : `<folder>/${folderName}`}.`}
            hideLabel
            onSave={async (p) => { setParent(p) }}
          />
          <div className="flex items-center gap-2">
            <button type="button" className={BTN} disabled={!!busy || !parent} onClick={() => { run('Moving…', () => onMove(parent)) }}>
              {busy === 'Moving…' ? busy : 'Move here'}
            </button>
            <button type="button" className="px-2 py-1 text-meta text-ink-muted hover:text-ink" disabled={!!busy} onClick={() => { setMoving(false) }}>Cancel</button>
          </div>
        </div>
      ) : !publishing ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {onMove && (
            <button type="button" className={BTN} disabled={!!busy} onClick={() => { setMoving(true) }}>
              <IconFolderShare size={14} stroke={2} /> Move to a folder…
            </button>
          )}
          {!place.git && (
            <button type="button" className={BTN} disabled={!!busy} onClick={() => { run('Initializing…', onGitInit) }}>
              <IconGitBranch size={14} stroke={2} /> {busy === 'Initializing…' ? busy : 'Make it a git repo'}
            </button>
          )}
          {!place.remote && !published && (
            <button type="button" className={BTN} disabled={!!busy || owners.length === 0} title={owners.length ? undefined : 'Sign in to GitHub on this machine (gh auth login) to publish'} onClick={() => { setPublishing(true) }}>
              <IconCloudUpload size={14} stroke={2} /> Publish to GitHub…
            </button>
          )}
          <button type="button" className="px-2 py-1 text-meta text-ink-muted hover:text-ink" onClick={onDismiss}>Not now</button>
        </div>
      ) : (
        <form
          className="mt-2 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            run('Publishing…', async () => {
              const url = await onPublish({ owner, name: name.trim(), visibility })
              setPublished(url)
              setPublishing(false)
            })
          }}
        >
          <select aria-label="Owner" className={INPUT} value={owner} onChange={(e) => { setOwner(e.target.value) }} disabled={!!busy}>
            {owners.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
          <span className="text-meta text-ink-muted">/</span>
          <input aria-label="Repository name" className={`${INPUT} min-w-0 flex-1 font-mono`} value={name} onChange={(e) => { setName(e.target.value) }} disabled={!!busy} />
          <select aria-label="Visibility" className={INPUT} value={visibility} onChange={(e) => { setVisibility(e.target.value === 'public' ? 'public' : 'private') }} disabled={!!busy}>
            <option value="private">Private</option>
            <option value="public">Public</option>
          </select>
          <button type="submit" className={BTN} disabled={!!busy || !owner || !name.trim()}>
            {busy === 'Publishing…' ? busy : 'Publish'}
          </button>
          <button type="button" className="px-2 py-1 text-meta text-ink-muted hover:text-ink" disabled={!!busy} onClick={() => { setPublishing(false) }}>Cancel</button>
          <p className="basis-full text-micro text-ink-muted">Commits everything in the folder, creates the repository with your GitHub login on this machine, and pushes.</p>
        </form>
      )}
      {error && <p className="mt-2 text-meta text-error-4" role="alert">{error}</p>}
    </div>
  )
}
