import type { ConnectionState } from '../types'

const stateConfig: Record<ConnectionState, { color: string; label: string }> = {
  connected: { color: 'bg-success-7', label: 'Connected' },
  connecting: { color: 'bg-warning-6', label: 'Connecting...' },
  disconnected: { color: 'bg-error-7', label: 'Disconnected' },
}

export function StatusIndicator({ state }: { state: ConnectionState }) {
  const { color, label } = stateConfig[state]

  return (
    <div className="flex items-center gap-2 text-[15px] text-neutral-6">
      <span className={`inline-block h-2 w-2 rounded-full ${color}`} />
      {label}
    </div>
  )
}
