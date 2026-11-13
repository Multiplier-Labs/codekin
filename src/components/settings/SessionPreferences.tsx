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
  getScratchRoot, setScratchRoot as setScratchRootApi,
} from '../../lib/ccApi'
import { FolderPicker } from '../FolderPicker'
import { Block, Row, Rows, button, checkbox, input } from './Block'
import { setPref, usePref } from '../../lib/prefs'

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
  const [scratchRoot, setScratchRoot] = useState('')
  const [scratchEffective, setScratchEffective] = useState('')
  const composer = usePref('newSessionComposer') === true

  useEffect(() => {
    if (!token) return
    getRetentionDays(token).then(setRetentionDays).catch(() => {})
    getReposPath(token).then(setReposPath).catch(() => {})
    getWorktreePrefix(token).then(setWorktreePrefix).catch(() => {})
    getQueueMessages(token).then(setQueueMessages).catch(() => {})
    getScratchRoot(token).then(r => { setScratchRoot(r.path); setScratchEffective(r.effective) }).catch(() => {})
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

      <NotificationPreferences />

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

      <Block title="New sessions">
        <Rows>
          <Row
            label="Start from a blank composer (preview)"
            htmlFor="settings-new-session-composer"
            description="New opens an empty composer: type first, then choose where the session runs: a scratch folder, any folder, or a repository."
            control={
              <input
                id="settings-new-session-composer"
                type="checkbox"
                checked={composer}
                onChange={e => { setPref('newSessionComposer', e.target.checked) }}
                className={checkbox}
              />
            }
          />
          <Row
            label="Scratch folder location"
            description={<>Scratch sessions each get a new folder here. They are never deleted automatically. Leave empty for the default{scratchEffective && !scratchRoot ? <> (<code className="font-mono">{scratchEffective}</code>)</> : null}.</>}
          >
            <div className="mt-2">
              <FolderPicker
                value={scratchRoot}
                token={token}
                placeholder="~/codekin/scratch (default)"
                hideLabel
                inputClass="text-body"
                onSave={async (p) => {
                  const saved = await setScratchRootApi(token, p)
                  setScratchRoot(saved.path)
                  setScratchEffective(saved.effective)
                }}
              />
            </div>
          </Row>
        </Rows>
      </Block>
    </div>
  )
}

/** Whether this page can ask the browser for notifications (the desktop app notifies by itself). */
function browserNotifications(): 'unsupported' | NotificationPermission {
  if (typeof Notification === 'undefined' || navigator.userAgent.includes('CodekinDesktop/')) return 'unsupported'
  return Notification.permission
}

/** The title count / Dock badge and quiet notifications for sessions that need you. */
function NotificationPreferences() {
  const needsInput = usePref('notifyNeedsInput') !== false
  const turnFinished = usePref('notifyTurnFinished') !== false
  const [permission, setPermission] = useState(browserNotifications)
  const desktop = typeof navigator !== 'undefined' && navigator.userAgent.includes('CodekinDesktop/')
  return (
    <Block title="Notifications">
      <Rows>
        <Row
          label="Tell me when a session needs me"
          htmlFor="settings-notify-input"
          description={desktop
            ? 'The Dock icon shows how many sessions are waiting, and macOS shows a quiet notification when one starts waiting while you are elsewhere.'
            : 'The tab title shows how many sessions are waiting, and, if you allow it, a quiet notification when one starts waiting while you are elsewhere.'}
          control={
            <input
              id="settings-notify-input"
              type="checkbox"
              checked={needsInput}
              onChange={e => { setPref('notifyNeedsInput', e.target.checked) }}
              className={checkbox}
            />
          }
        />
        <Row
          label="Include finished turns"
          htmlFor="settings-notify-finished"
          description="Also count a session that finished and is waiting for your next message, not only ones asking for approval or an answer."
          control={
            <input
              id="settings-notify-finished"
              type="checkbox"
              checked={turnFinished}
              disabled={!needsInput}
              onChange={e => { setPref('notifyTurnFinished', e.target.checked) }}
              className={checkbox}
            />
          }
        />
        {needsInput && permission !== 'unsupported' && permission !== 'granted' && (
          <Row
            label="Browser notifications"
            description={permission === 'denied'
              ? 'Blocked for this site. Allow notifications in your browser’s site settings to get them.'
              : 'Off for now: only the tab title shows the count.'}
            control={permission === 'default' ? (
              <button
                type="button"
                className={button}
                onClick={() => { void Notification.requestPermission().then(setPermission) }}
              >
                Allow notifications
              </button>
            ) : null}
          />
        )}
      </Rows>
    </Block>
  )
}
