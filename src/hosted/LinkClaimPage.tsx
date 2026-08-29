/**
 * Claim screen for a device-link QR (/link#<code>).
 *
 * Runs before the auth gate: the whole point is that this device is not
 * signed in yet. Claims the code from the URL fragment, then — while the
 * user is literally holding the phone — offers passkey enrollment so the
 * next sign-in is one biometric prompt.
 */

import { useState, useEffect, useRef } from 'react'
import { claimDeviceLink, codeFromHash, type ClaimFailure } from './deviceLink'
import {
  passkeysSupported,
  registerPasskey,
  defaultPasskeyLabel,
  isPasskeyCancel,
} from './passkeys'
import type { HostedUser } from './useHostedAuth'

type Phase =
  | { name: 'claiming'; code: string }
  | { name: 'offer-passkey'; user: HostedUser }
  | { name: 'enrolling'; user: HostedUser }
  | { name: 'failed'; reason: ClaimFailure }

const FAILURE_MESSAGES: Record<ClaimFailure, string> = {
  expired: 'This link expired. Generate a fresh QR code on the signed-in device and scan again.',
  invalid: 'This link is not valid — it may have been used already. Generate a fresh QR code and scan again.',
  not_allowed: 'The account that created this link no longer has access.',
  network: 'Could not reach the server. Check the connection and reload this page.',
}

function enterApp() {
  window.location.replace('/')
}

export function LinkClaimPage() {
  const [phase, setPhase] = useState<Phase>(() => {
    const code = codeFromHash(window.location.hash)
    return code ? { name: 'claiming', code } : { name: 'failed', reason: 'invalid' }
  })
  const [enrollError, setEnrollError] = useState<string | null>(null)
  const claimStarted = useRef(false)

  useEffect(() => {
    if (phase.name !== 'claiming') return
    // Effects can run twice (StrictMode); the code is single-use, so claim once.
    if (claimStarted.current) return
    claimStarted.current = true

    // Drop the code from the address bar before anything else can observe it
    history.replaceState(null, '', '/link')
    void claimDeviceLink(phase.code).then(result => {
      if (!result.ok) {
        setPhase({ name: 'failed', reason: result.reason })
        return
      }
      if (passkeysSupported()) {
        setPhase({ name: 'offer-passkey', user: result.user })
      } else {
        enterApp()
      }
    })
  }, [phase])

  const enroll = async (user: HostedUser) => {
    setPhase({ name: 'enrolling', user })
    setEnrollError(null)
    try {
      await registerPasskey(defaultPasskeyLabel())
      enterApp()
    } catch (err) {
      setPhase({ name: 'offer-passkey', user })
      if (!isPasskeyCancel(err)) setEnrollError('That did not work — you can try again or skip.')
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-page">
      <div className="w-full max-w-sm rounded-floating border border-edge bg-surface p-8 text-center">
        <h1 className="mb-2 font-mono text-head text-ink">Codekin</h1>

        {phase.name === 'claiming' && (
          <p className="text-body text-ink-muted">Linking this device…</p>
        )}

        {(phase.name === 'offer-passkey' || phase.name === 'enrolling') && (
          <>
            <p className="mb-2 text-body text-ink">
              Signed in as <span className="font-mono">{phase.user.login}</span>.
            </p>
            <p className="mb-6 text-meta text-ink-muted">
              Add a passkey so this device can sign back in with Face ID, fingerprint, or its
              PIN — no password, no GitHub.
            </p>
            {enrollError && <p className="mb-4 text-meta text-error-4">{enrollError}</p>}
            <button
              onClick={() => void enroll(phase.user)}
              disabled={phase.name === 'enrolling'}
              className="mb-2 w-full rounded-control bg-primary-8 px-4 py-2.5 text-body font-medium text-on-primary transition hover:bg-primary-7 disabled:opacity-50"
            >
              {phase.name === 'enrolling' ? 'Waiting for the authenticator…' : 'Enable biometric sign-in'}
            </button>
            <button
              onClick={enterApp}
              className="w-full rounded-control border border-edge px-4 py-2.5 text-body text-ink-muted transition hover:bg-surface-raised hover:text-ink"
            >
              Skip for now
            </button>
          </>
        )}

        {phase.name === 'failed' && (
          <>
            <p className="mb-6 text-body text-ink-muted">{FAILURE_MESSAGES[phase.reason]}</p>
            <a
              href="/"
              className="block w-full rounded-control border border-edge px-4 py-2.5 text-body text-ink-muted transition hover:bg-surface-raised hover:text-ink"
            >
              Go to sign-in
            </a>
          </>
        )}
      </div>
    </div>
  )
}
