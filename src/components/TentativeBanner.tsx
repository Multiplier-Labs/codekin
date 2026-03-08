/**
 * Banner shown above the input bar when a session has queued (tentative) messages.
 *
 * Appears when the active session has messages waiting to be sent because
 * another session for the same repo is currently running. Offers Execute
 * and Discard actions.
 */

interface Props {
  count: number
  repoName: string
  onExecute: () => void
  onDiscard: () => void
}

export function TentativeBanner({ count, repoName, onExecute, onDiscard }: Props) {
  return (
    <div className="flex items-center justify-between border-t border-warning-8/50 bg-warning-11/30 px-4 py-2 flex-shrink-0">
      <span className="text-[15px] text-warning-4">
        ⏸ {count} message{count !== 1 ? 's' : ''} queued — waiting for{' '}
        <span className="font-medium text-warning-3">{repoName}</span> session to finish
      </span>
      <div className="flex gap-2">
        <button
          onClick={onExecute}
          className="rounded px-2.5 py-1 text-[13px] bg-warning-9/30 hover:bg-warning-8/50 text-warning-3 transition-colors"
        >
          Execute now
        </button>
        <button
          onClick={onDiscard}
          className="rounded px-2.5 py-1 text-[13px] text-neutral-4 hover:text-neutral-2 hover:bg-neutral-8/50 transition-colors"
        >
          Discard
        </button>
      </div>
    </div>
  )
}
