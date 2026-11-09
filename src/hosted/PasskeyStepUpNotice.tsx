/**
 * Says why the passkey prompt is up (signed-intents spec §6.6b). The OS
 * prompt can't carry our text, so while the signer waits for a passkey on a
 * privileged action this floats above the page: what made the action
 * privileged, and that this browser won't be asked again for a while.
 */

import { useEffect, useState } from 'react'
import { IconFingerprint } from '@tabler/icons-react'
import { STEP_UP_WINDOW_MS, type StepUpReason } from '../../server/relay/intent-actions'
import { PASSKEY_STEP_UP_EVENT, type PasskeyStepUpDetail } from './intentSigner'

const WHY: Record<StepUpReason, string> = {
  bypass: 'This session uses bypass permissions, so it runs commands without asking you first.',
  'allowed-tools': 'This session pre-approves tools, so they run without asking you first.',
  'standing-approval': 'You are saving an "always allow" rule, so matching commands will run without asking you first.',
  automation: 'You are setting up an automation, which starts agent sessions on this computer without you watching.',
}

function stepUpMessage(reason: StepUpReason | null): string {
  return reason ? WHY[reason] : 'This is a sensitive action on this computer.'
}

export function PasskeyStepUpNotice() {
  const [detail, setDetail] = useState<PasskeyStepUpDetail | null>(null)
  useEffect(() => {
    const onStepUp = (e: Event) => {
      const d = (e as CustomEvent<PasskeyStepUpDetail>).detail
      setDetail(d.active ? d : null)
    }
    window.addEventListener(PASSKEY_STEP_UP_EVENT, onStepUp)
    return () => { window.removeEventListener(PASSKEY_STEP_UP_EVENT, onStepUp) }
  }, [])
  if (!detail) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 top-4 z-50 flex justify-center px-4">
      <div role="status" aria-live="polite" className="pointer-events-auto w-full max-w-md rounded-floating border border-edge-strong bg-surface-raised p-4 shadow-floating">
        <p className="flex items-center gap-2 text-body font-medium text-ink">
          <IconFingerprint size={18} className="shrink-0 text-primary-5" /> Confirm with your passkey
        </p>
        <p className="mt-1 text-meta text-ink-muted">{stepUpMessage(detail.reason)}</p>
        {detail.reason && (
          <p className="mt-1 text-meta text-ink-faint">
            This browser won't ask again for {Math.round(STEP_UP_WINDOW_MS / 60_000)} minutes.
          </p>
        )}
      </div>
    </div>
  )
}
