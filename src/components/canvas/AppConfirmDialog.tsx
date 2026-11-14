/**
 * What an MCP App asks to do on the user's behalf (open a link, send a
 * message as the user, run a tool), confirmed in Codekin's own chrome.
 *
 * The app chooses when to ask and what the request says, so the dialog
 * guards against approving by accident: Cancel has focus, the approve button
 * only works after a short pause (a click or key press already on its way
 * doesn't land on it), Escape cancels, links show their real host, and
 * control and direction-override characters are removed from what is shown.
 */

import { useEffect, useRef, useState } from 'react'
import { IconExternalLink, IconMessage, IconTool } from '@tabler/icons-react'
import { ARM_MS, linkHost, visibleText } from '../../lib/appConfirm'

export interface AppConfirmRequest {
  id: number
  kind: 'link' | 'message' | 'tool'
  /** The link, the message, or the tool's arguments (JSON). */
  text: string
  tool?: string
  resolve: (ok: boolean) => void
}

interface Props {
  request: AppConfirmRequest
  server: string
  /** Further requests waiting behind this one. */
  waiting: number
}

export function AppConfirmDialog({ request, server, waiting }: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    setArmed(false) // eslint-disable-line react-hooks/set-state-in-effect -- each request starts unarmed
    cancelRef.current?.focus()
    const timer = setTimeout(() => { setArmed(true) }, ARM_MS)
    return () => { clearTimeout(timer) }
  }, [request.id])

  const shown = visibleText(request.text)
  const host = request.kind === 'link' ? linkHost(request.text) : null
  const title = request.kind === 'link' ? 'Open a link' : request.kind === 'tool' ? 'Run a tool' : 'Send a message as you'
  const Icon = request.kind === 'link' ? IconExternalLink : request.kind === 'tool' ? IconTool : IconMessage

  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center bg-page/60 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); request.resolve(false) } }}
    >
      <div className="w-full max-w-[460px] rounded-floating border border-edge-strong bg-surface-raised p-4 shadow-floating">
        <div className="flex items-center gap-2 text-body font-bold text-ink">
          <Icon size={18} className="shrink-0 text-warning-5" />
          <span className="min-w-0 break-words">
            {request.kind === 'link' ? `${server} wants to open a link` : request.kind === 'tool' ? `${server} wants to run ${request.tool ?? 'a tool'}` : `${server} wants to send a message as you`}
          </span>
        </div>
        {request.kind === 'link' && (
          <p className="mt-3 text-meta text-ink-muted">Goes to <span className="font-mono font-bold text-ink">{host ?? 'an address that is not a web link'}</span></p>
        )}
        <div className={`mt-2 max-h-[240px] overflow-y-auto rounded-control border border-edge bg-page px-3 py-2 text-meta text-ink ${request.kind === 'link' ? 'break-all font-mono' : request.kind === 'tool' ? 'whitespace-pre-wrap break-words font-mono' : 'whitespace-pre-wrap break-words'}`}>{shown}</div>
        <p className="mt-2 text-meta text-ink-muted">
          {request.kind === 'link' ? 'It opens in a new tab.'
            : request.kind === 'tool' ? `It runs on this computer with these arguments, through the session's connection to ${server}. The result goes to the app, not the agent.`
            : 'It goes to the agent as your message and shows in the chat.'}
          {shown.length > 600 && ` ${shown.length.toLocaleString()} characters: scroll to read all of it.`}
          {waiting > 0 && ` ${waiting} more request${waiting === 1 ? '' : 's'} waiting.`}
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <button ref={cancelRef} type="button" onClick={() => { request.resolve(false) }} className="rounded-control px-3 py-1.5 text-meta text-ink-muted hover:text-ink focus:outline focus:outline-2 focus:outline-focus">Cancel</button>
          <button
            type="button"
            disabled={!armed}
            onClick={() => { if (armed) request.resolve(true) }}
            className="rounded-control bg-primary-fill px-3 py-1.5 text-meta font-medium text-on-primary-fill hover:opacity-90 disabled:opacity-50"
          >
            {request.kind === 'link' ? 'Open link' : request.kind === 'tool' ? 'Run tool' : 'Send message'}
          </button>
        </div>
      </div>
    </div>
  )
}
