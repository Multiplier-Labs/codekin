/**
 * ConnectionPopup — shows which machine the app is talking to, plus the status
 * of the Claude Code, OpenCode, and Codex connections on it, with toggle
 * buttons to temporarily disable/enable each.
 */

import { useRef, useEffect } from 'react'
import { transport } from '../lib/transport'
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
    ? 'bg-ink-faint'
    : claudeState === 'connected' ? 'bg-success-7' : claudeState === 'connecting' ? 'bg-warning-6' : 'bg-error-7'
  const claudeLabel = claudeDisabled
    ? 'Disabled'
    : claudeState === 'connected' ? 'Connected' : claudeState === 'connecting' ? 'Connecting' : 'Disconnected'

  const ocDotColor = openCodeDisabled
    ? 'bg-ink-faint'
    : openCodeConnected === true ? 'bg-success-7' : openCodeConnected === false ? 'bg-error-7' : 'bg-ink-faint'
  const ocLabel = openCodeDisabled
    ? 'Disabled'
    : openCodeConnected === true ? 'Connected' : openCodeConnected === false ? 'Disconnected' : 'Not configured'

  const codexDotColor = codexDisabled
    ? 'bg-ink-faint'
    : codexConnected === true ? 'bg-success-7' : codexConnected === false ? 'bg-error-7' : 'bg-ink-faint'
  const codexLabel = codexDisabled
    ? 'Disabled'
    : codexConnected === true ? 'Connected' : codexConnected === false ? 'Run `codex login` on the host' : 'Not configured'

  // Where this browser is pointed: the local host, or the paired machine and
  // the control plane it is reached through.
  const target = transport.describeTarget()

  return (
    <div
      ref={ref}
      className="absolute bottom-full left-0 mb-2 w-64 rounded-floating border border-edge-strong bg-surface-raised shadow-floating z-50"
    >
      <div className="px-3 py-2 border-b border-edge">
        <div className="text-micro font-medium uppercase tracking-wider text-ink-muted">
          Connected to
        </div>
        <div className="mt-0.5 flex items-baseline gap-1.5">
          <span className="font-mono text-body text-ink truncate" title={target.label}>
            {target.label}
          </span>
          <span className="text-micro text-ink-muted flex-shrink-0">{target.detail}</span>
        </div>
      </div>

      <div className="px-3 py-2 border-b border-edge text-micro font-medium uppercase tracking-wider text-ink-muted">
        Connections
      </div>

      {/* Claude Code */}
      <div className="px-3 py-2.5 flex items-center gap-2">
        <StatusDot color={claudeDotColor} />
        <div className="flex-1 min-w-0">
          <div className="text-body text-ink font-medium">Claude Code</div>
          <div className="text-micro text-ink-muted">{claudeLabel}</div>
        </div>
        <button
          onClick={onToggleClaude}
          className={`text-micro px-2 py-0.5 rounded-control border transition-colors ${
            claudeDisabled
              ? 'border-success-8/50 text-success-5 hover:bg-success-9/20'
              : 'border-edge text-ink-muted hover:bg-edge'
          }`}
        >
          {claudeDisabled ? 'Enable' : 'Disable'}
        </button>
      </div>

      {/* OpenCode */}
      <div className="px-3 py-2.5 flex items-center gap-2 border-t border-edge">
        <StatusDot color={ocDotColor} />
        <div className="flex-1 min-w-0">
          <div className="text-body text-ink font-medium">OpenCode</div>
          <div className="text-micro text-ink-muted">{ocLabel}</div>
        </div>
        <button
          onClick={onToggleOpenCode}
          className={`text-micro px-2 py-0.5 rounded-control border transition-colors ${
            openCodeDisabled
              ? 'border-success-8/50 text-success-5 hover:bg-success-9/20'
              : 'border-edge text-ink-muted hover:bg-edge'
          }`}
        >
          {openCodeDisabled ? 'Enable' : 'Disable'}
        </button>
      </div>

      {/* Codex */}
      <div className="px-3 py-2.5 flex items-center gap-2 border-t border-edge">
        <StatusDot color={codexDotColor} />
        <div className="flex-1 min-w-0">
          <div className="text-body text-ink font-medium">Codex</div>
          <div className="text-micro text-ink-muted">{codexLabel}</div>
        </div>
        <button
          onClick={onToggleCodex}
          className={`text-micro px-2 py-0.5 rounded-control border transition-colors ${
            codexDisabled
              ? 'border-success-8/50 text-success-5 hover:bg-success-9/20'
              : 'border-edge text-ink-muted hover:bg-edge'
          }`}
        >
          {codexDisabled ? 'Enable' : 'Disable'}
        </button>
      </div>
    </div>
  )
}
