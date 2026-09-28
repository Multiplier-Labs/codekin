/**
 * Session preferences (machine settings): archive retention, cross-session
 * message queueing, the repos path and worktree defaults. Loads its values
 * from the connected machine when it mounts; each change saves immediately.
 */

import { useEffect, useState } from 'react'
import {
  getRetentionDays, setRetentionDays as setRetentionDaysApi,
  getReposPath, setReposPath as setReposPathApi,
  getWorktreePrefix, setWorktreePrefix as setWorktreePrefixApi,
  getQueueMessages, setQueueMessages as setQueueMessagesApi,
} from '../../lib/ccApi'
import { FolderPicker } from '../FolderPicker'
import { Block, Row, Rows, checkbox, input } from './Block'

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
    <div className="space-y-4">
      <Block title="Archive & queueing">
        <Rows>
          <Row
            label="Keep archived sessions for"
            htmlFor="settings-retention"
            description="Archived sessions older than this are deleted automatically, in every repo."
            control={
              <>
                <input
                  id="settings-retention"
                  type="number"
                  min={1}
                  max={365}
                  value={retentionDays}
                  onChange={e => {
                    const days = Math.max(1, Math.min(365, Number(e.target.value)))
                    setRetentionDays(days)
                    setRetentionDaysApi(token, days).catch(() => { onError('Failed to save retention setting'); })
                  }}
                  className={`${input} w-20`}
                />
                <span className="text-body text-ink-muted">days</span>
              </>
            }
          />
          <Row
            label="Queue messages across sessions"
            htmlFor="settings-queue-messages"
            description="A message sent while another session in the same repo is working waits, and goes out when that session finishes."
            control={
              <input
                id="settings-queue-messages"
                type="checkbox"
                checked={queueMessages}
                onChange={e => {
                  const next = e.target.checked
                  setQueueMessages(next)
                  setQueueMessagesApi(token, next).catch(() => { onError('Failed to save queue messages setting'); })
                }}
                className={checkbox}
              />
            }
          />
        </Rows>
      </Block>

      <Block title="Repositories & worktrees">
        <Rows>
          <Row
            label="Repositories path"
            description="The folder holding your cloned repositories. Leave empty to use the server default."
          >
            <div className="mt-2">
              <FolderPicker
                value={reposPath}
                token={token}
                placeholder="~/repos (default)"
                hideLabel
                inputClass="text-body"
                onSave={async (p) => {
                  await setReposPathApi(token, p)
                  setReposPath(p)
                }}
              />
            </div>
          </Row>
          <Row
            label="Start new sessions in a worktree"
            htmlFor="settings-auto-worktree"
            description="Each new session gets its own git worktree, so parallel sessions do not touch each other's files."
            control={
              <input
                id="settings-auto-worktree"
                type="checkbox"
                checked={autoWorktree}
                onChange={e => onAutoWorktreeChange?.(e.target.checked)}
                className={checkbox}
              />
            }
          />
          <Row
            label="Worktree branch prefix"
            htmlFor="settings-worktree-prefix"
            description={<>Put in front of worktree branch names: <code className="font-mono">wt/</code> gives <code className="font-mono">wt/abc12345</code>.</>}
            control={
              <input
                id="settings-worktree-prefix"
                type="text"
                value={worktreePrefix}
                onChange={e => {
                  const val = e.target.value
                  setWorktreePrefix(val)
                  setWorktreePrefixApi(token, val).catch(() => { onError('Failed to save worktree prefix'); })
                }}
                placeholder="wt/"
                className={`${input} w-40 font-mono`}
              />
            }
          />
        </Rows>
      </Block>
    </div>
  )
}
