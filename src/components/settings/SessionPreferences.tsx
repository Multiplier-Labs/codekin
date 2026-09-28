/**
 * Session preferences (machine settings): archive retention, cross-session
 * message queueing, the repos path and worktree defaults. Loads its values
 * from the connected machine when it mounts; each change saves immediately.
 */

import { useEffect, useState } from 'react'
import { IconArchive, IconGitBranch } from '@tabler/icons-react'
import {
  getRetentionDays, setRetentionDays as setRetentionDaysApi,
  getReposPath, setReposPath as setReposPathApi,
  getWorktreePrefix, setWorktreePrefix as setWorktreePrefixApi,
  getQueueMessages, setQueueMessages as setQueueMessagesApi,
} from '../../lib/ccApi'
import { FolderPicker } from '../FolderPicker'

interface Props {
  token: string
  autoWorktree: boolean
  onAutoWorktreeChange?: (enabled: boolean) => void
  onError: (message: string) => void
}

export function SessionPreferences({ token, autoWorktree, onAutoWorktreeChange, onError }: Props) {
  const [retentionDays, setRetentionDays] = useState(7)
  const [reposPath, setReposPath] = useState('')
  const [worktreePrefix, setWorktreePrefix] = useState('wt/')
  const [queueMessages, setQueueMessages] = useState(false)

  useEffect(() => {
    if (!token) return
    getRetentionDays(token).then(setRetentionDays).catch(() => {})
    getReposPath(token).then(setReposPath).catch(() => {})
    getWorktreePrefix(token).then(setWorktreePrefix).catch(() => {})
    getQueueMessages(token).then(setQueueMessages).catch(() => {})
  }, [token])

  return (
    <>
      <div className="grid grid-cols-2 gap-x-6 gap-y-4">
        {/* Archived Session Retention */}
        <div>
          <label className="mb-1.5 block text-body text-ink-muted">
            <span className="flex items-center gap-1.5">
              <IconArchive size={14} className="text-ink-muted" />
              Archived Session Retention
            </span>
          </label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={365}
              value={retentionDays}
              onChange={e => {
                const days = Math.max(1, Math.min(365, Number(e.target.value)))
                setRetentionDays(days)
                setRetentionDaysApi(token, days).catch(() => onError('Failed to save retention setting'))
              }}
              className="w-20 rounded-control border border-edge bg-surface px-3 py-2 text-body text-ink outline-none focus:border-primary-7"
            />
            <span className="text-body text-ink-muted">days</span>
          </div>
          <p className="mt-1 text-body text-ink-muted">Auto-delete archived sessions older than this. Applies to every repo.</p>
        </div>
      </div>

      <div className="border-t border-edge" />

      {/* ─ Sessions ─ */}
      <div>
        <label className="flex items-center gap-2.5 cursor-pointer group">
          <input
            type="checkbox"
            checked={queueMessages}
            onChange={e => {
              const next = e.target.checked
              setQueueMessages(next)
              setQueueMessagesApi(token, next).catch(() => onError('Failed to save queue messages setting'))
            }}
            className="h-4 w-4 rounded border-edge-strong bg-surface-raised text-primary-7 accent-primary-7 cursor-pointer"
          />
          <span className="text-body text-ink-muted group-hover:text-ink transition-colors">
            Queue messages across sessions
          </span>
        </label>
        <p className="mt-1 ml-[26px] text-body text-ink-muted">
          When enabled, messages sent while another session for the same repo is processing will be queued and sent automatically when it finishes.
        </p>
      </div>

      <div className="border-t border-edge" />

      {/* ─ Repository ─ */}
      <div className="space-y-4">
        <FolderPicker
          value={reposPath}
          token={token}
          placeholder="~/repos (default)"
          helpText="Absolute path to your locally cloned repositories. Leave empty to use the server default."
          inputClass="text-body"
          onSave={async (p) => {
            await setReposPathApi(token, p)
            setReposPath(p)
          }}
        />

        <div>
          <label className="flex items-center gap-2.5 cursor-pointer group">
            <input
              type="checkbox"
              checked={autoWorktree}
              onChange={e => onAutoWorktreeChange?.(e.target.checked)}
              className="h-4 w-4 rounded border-edge-strong bg-surface-raised text-primary-7 accent-primary-7 cursor-pointer"
            />
            <span className="flex items-center gap-1.5 text-body text-ink-muted group-hover:text-ink transition-colors">
              <IconGitBranch size={14} className="text-ink-muted" />
              Auto-enable worktrees for new sessions
            </span>
          </label>
          <p className="mt-1 ml-[26px] text-body text-ink-muted">When enabled, new sessions will automatically start in a git worktree</p>
        </div>

        <div>
          <label className="mb-1.5 block text-body text-ink-muted">Worktree Branch Prefix</label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={worktreePrefix}
              onChange={e => {
                const val = e.target.value
                setWorktreePrefix(val)
                setWorktreePrefixApi(token, val).catch(() => onError('Failed to save worktree prefix'))
              }}
              placeholder="wt/"
              className="w-40 rounded-control border border-edge bg-surface px-3 py-2 text-body text-ink outline-none focus:border-primary-7"
            />
          </div>
          <p className="mt-1 text-body text-ink-muted">Prefix for worktree branch names (e.g. wt/ → wt/abc12345)</p>
        </div>
      </div>
    </>
  )
}
