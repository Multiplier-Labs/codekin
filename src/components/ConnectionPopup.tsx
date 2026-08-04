/**
 * ConnectionPopup — shows status of Claude Code, OpenCode, and Codex connections
 * with toggle buttons to temporarily disable/enable each.
 */

import { useRef, useEffect } from 'react'
import type { ConnectionState } from '../types'

interface Props {
  /** Claude Code WebSocket connection state. */
  claudeState: ConnectionState
  /** Whether Claude Code connection is disabled by the user. */
  claudeDisabled: boolean
  /** Toggle Claude Code connection on/off. */
  onToggleClaude: () => void
  /** OpenCode connection state: true=connected, false=disconnected, null=unknown/not configured. */
  openCodeConnected: boolean | null
  /** Whether OpenCode connection is disabled by the user. */
  openCodeDisabled: boolean
  /** Toggle OpenCode connection on/off. */
  onToggleOpenCode: () => void
  /** Codex connection state: true=connected, false=disconnected, null=unknown/not configured. */
  codexConnected: boolean | null
  /** Whether Codex connection is disabled by the user. */
  codexDisabled: boolean
  /** Toggle Codex connection on/off. */
  onToggleCodex: () => void
  /** Close the popup. */
  onClose: () => void
}

function StatusDot({ color }: { color: string }) {
  return <span className={`inline-block h-2 w-2 rounded-full flex-shrink-0 ${color}`} />
}

export function ConnectionPopup({
  claudeState,
  claudeDisabled,
  onToggleClaude,
  openCodeConnected,
  openCodeDisabled,
  onToggleOpenCode,
  codexConnected,
  codexDisabled,
  onToggleCodex,
  onClose,
}: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [onClose])

  const claudeDotColor = claudeDisabled
    ? 'bg-neutral-6'
    : claudeState === 'connected' ? 'bg-success-7' : claudeState === 'connecting' ? 'bg-warning-6' : 'bg-error-7'
  const claudeLabel = claudeDisabled
    ? 'Disabled'
    : claudeState === 'connected' ? 'Connected' : claudeState === 'connecting' ? 'Connecting' : 'Disconnected'

  const ocDotColor = openCodeDisabled
    ? 'bg-neutral-6'
    : openCodeConnected === true ? 'bg-success-7' : openCodeConnected === false ? 'bg-error-7' : 'bg-neutral-6'
  const ocLabel = openCodeDisabled
    ? 'Disabled'
    : openCodeConnected === true ? 'Connected' : openCodeConnected === false ? 'Disconnected' : 'Not configured'

  const codexDotColor = codexDisabled
    ? 'bg-neutral-6'
    : codexConnected === true ? 'bg-success-7' : codexConnected === false ? 'bg-error-7' : 'bg-neutral-6'
  const codexLabel = codexDisabled
    ? 'Disabled'
    : codexConnected === true ? 'Connected' : codexConnected === false ? 'Run `codex login` on the host' : 'Not configured'

  return (
    <div
      ref={ref}
      className="absolute bottom-full left-0 mb-2 w-56 rounded-floating border border-edge-strong bg-surface-raised shadow-floating z-50"
    >
      <div className="px-3 py-2 border-b border-edge text-micro font-medium uppercase tracking-wider text-neutral-5">
        Connections
      </div>

      {/* Claude Code */}
      <div className="px-3 py-2.5 flex items-center gap-2">
        <StatusDot color={claudeDotColor} />
        <div className="flex-1 min-w-0">
          <div className="text-body text-neutral-2 font-medium">Claude Code</div>
          <div className="text-micro text-neutral-5">{claudeLabel}</div>
        </div>
        <button
          onClick={onToggleClaude}
          className={`text-micro px-2 py-0.5 rounded-control border transition-colors ${
            claudeDisabled
              ? 'border-success-8/50 text-success-5 hover:bg-success-9/20'
              : 'border-edge text-neutral-4 hover:bg-neutral-8/30'
          }`}
        >
          {claudeDisabled ? 'Enable' : 'Disable'}
        </button>
      </div>

      {/* OpenCode */}
      <div className="px-3 py-2.5 flex items-center gap-2 border-t border-edge">
        <StatusDot color={ocDotColor} />
        <div className="flex-1 min-w-0">
          <div className="text-body text-neutral-2 font-medium">OpenCode</div>
          <div className="text-micro text-neutral-5">{ocLabel}</div>
        </div>
        <button
          onClick={onToggleOpenCode}
          className={`text-micro px-2 py-0.5 rounded-control border transition-colors ${
            openCodeDisabled
              ? 'border-success-8/50 text-success-5 hover:bg-success-9/20'
              : 'border-edge text-neutral-4 hover:bg-neutral-8/30'
          }`}
        >
          {openCodeDisabled ? 'Enable' : 'Disable'}
        </button>
      </div>

      {/* Codex */}
      <div className="px-3 py-2.5 flex items-center gap-2 border-t border-edge">
        <StatusDot color={codexDotColor} />
        <div className="flex-1 min-w-0">
          <div className="text-body text-neutral-2 font-medium">Codex</div>
          <div className="text-micro text-neutral-5">{codexLabel}</div>
        </div>
        <button
          onClick={onToggleCodex}
          className={`text-micro px-2 py-0.5 rounded-control border transition-colors ${
            codexDisabled
              ? 'border-success-8/50 text-success-5 hover:bg-success-9/20'
              : 'border-edge text-neutral-4 hover:bg-neutral-8/30'
          }`}
        >
          {codexDisabled ? 'Enable' : 'Disable'}
        </button>
      </div>
    </div>
  )
}
