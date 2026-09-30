/**
 * Banner shown above the input bar when an isolated session's worktree is
 * unavailable (creation failed, the directory disappeared, or its working
 * files were removed from the Archive tab).
 *
 * The session never falls back to the shared checkout on its own: nothing
 * runs, and messages sent meanwhile are held by the server. The user either
 * retries the worktree or explicitly switches to the shared checkout.
 */

interface Props {
  state: 'failed' | 'missing' | 'removed'
  error?: string
  onRetry: () => void
  onUseExistingCheckout: () => void
}

export function WorktreeRecoveryBanner({ state, error, onRetry, onUseExistingCheckout }: Props) {
  const headline = state === 'removed'
    ? 'Working files were removed'
    : state === 'missing' ? 'Worktree is missing' : 'Worktree could not be created'
  return (
    <div role="alert" className="flex items-center justify-between gap-3 border-t border-error-9/50 bg-error-10/40 px-4 py-2 flex-shrink-0">
      <div className="min-w-0 text-body text-error-4">
        <span className="font-medium text-error-3">{headline}.</span>{' '}
        {error && <span className="break-words">{error} </span>}
        Nothing runs until you retry or switch; messages you send are held.
      </div>
      <div className="flex flex-shrink-0 gap-2">
        <button
          onClick={onRetry}
          className="rounded-control px-2.5 py-1 text-body bg-error-9/20 hover:bg-error-9/40 text-error-3 transition-colors"
        >
          Retry worktree
        </button>
        <button
          onClick={onUseExistingCheckout}
          title="Run this session in the repository's shared checkout instead of its own worktree"
          className="rounded-control px-2.5 py-1 text-body text-ink-muted hover:text-ink hover:bg-surface-raised transition-colors"
        >
          Use shared checkout
        </button>
      </div>
    </div>
  )
}
