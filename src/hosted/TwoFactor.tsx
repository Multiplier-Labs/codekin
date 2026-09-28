/**
 * Two-factor authentication screens (hosted only):
 * - MfaChallengePage: the second step after GitHub sign-in;
 * - MfaEnrollPage: shown when the account's role requires 2FA but none is set up;
 * - TwoFactorPanel: the Settings panel to add/remove factors and recovery codes;
 * - StepUpHost: the "confirm it's you" dialog behind stepUpFetch (./mfa).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { toDataURL } from 'qrcode'
import { IconShieldCheck } from '@tabler/icons-react'
import {
  StepUpCancelled,
  beginTotpSetup,
  confirmTotpSetup,
  disableTotp,
  fetchMfaStatus,
  isStepUpCancel,
  regenerateRecoveryCodes,
  setStepUpHandler,
  verifyCode,
  verifyWithPasskey,
  type MfaStatus,
  type StepUpMethod,
} from './mfa'
import { Row, Rows, button as settingsButton, dangerButton } from '../components/settings/Block'
import { defaultPasskeyLabel, isPasskeyCancel, passkeysSupported, registerPasskey } from './passkeys'

const button =
  'rounded-control border border-edge px-3 py-1.5 text-meta text-ink-muted transition hover:bg-surface-raised hover:text-ink disabled:opacity-50'
const primary =
  'rounded-control bg-primary-6 px-4 py-2 text-body text-ink-inverse transition hover:bg-primary-7 disabled:opacity-50'
const input =
  'w-full rounded-control border border-edge bg-surface px-3 py-2 font-mono text-body text-ink focus:border-focus focus:outline-none'

function messageOf(err: unknown): string | null {
  if (isPasskeyCancel(err) || isStepUpCancel(err)) return null
  return err instanceof Error ? err.message : 'Something went wrong. Try again.'
}

/** Recovery codes, shown once, with the ways to keep them. */
export function RecoveryCodesView({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)
  const text = codes.join('\n')
  const download = () => {
    const url = URL.createObjectURL(new Blob([`Codekin recovery codes\n\n${text}\n`], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'codekin-recovery-codes.txt'
    a.click()
    URL.revokeObjectURL(url)
  }
  return (
    <div>
      <p className="text-body text-ink">Save your recovery codes</p>
      <p className="mt-1 text-meta text-ink-muted">
        Each works once, if you lose your authenticator or passkeys. They will not be shown again.
      </p>
      <ol className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 rounded-control border border-edge bg-surface px-4 py-3 font-mono text-body text-ink">
        {codes.map(code => <li key={code}>{code}</li>)}
      </ol>
      <div className="mt-3 flex flex-wrap gap-2">
        <button onClick={() => { void navigator.clipboard.writeText(text).then(() => { setCopied(true) }) }} className={button}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button onClick={download} className={button}>Download</button>
      </div>
      <label className="mt-4 flex items-center gap-2 text-meta text-ink-muted">
        <input type="checkbox" checked={saved} onChange={e => { setSaved(e.target.checked) }} />
        I have saved these codes somewhere safe
      </label>
      <button onClick={onDone} disabled={!saved} className={`${primary} mt-3`}>Continue</button>
    </div>
  )
}

/** Authenticator-app setup: QR (and the key for manual entry), then a code to confirm. */
export function TotpSetup({ onDone, onCancel }: { onDone: (recoveryCodes: string[]) => void; onCancel?: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    beginTotpSetup()
      .then(async ({ secret, uri }) => {
        const qr = await toDataURL(uri, { width: 200, margin: 2 })
        if (!cancelled) setSetup({ secret, qr })
      })
      .catch((err: unknown) => {
        const message = messageOf(err)
        if (!cancelled) {
          if (message) setError(message)
          else onCancel?.()
        }
      })
    return () => { cancelled = true }
  }, [onCancel])

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      onDone(await confirmTotpSetup(code.trim()))
    } catch (err) {
      setError(messageOf(err))
      setBusy(false)
    }
  }

  if (!setup) {
    return error ? <p className="text-meta text-error-4">{error}</p> : <p className="text-body text-ink-muted">Preparing…</p>
  }
  return (
    <div>
      <p className="text-body text-ink">Scan this with your authenticator app</p>
      <p className="mt-1 text-meta text-ink-muted">1Password, Google Authenticator, Authy and others all work.</p>
      <div className="mt-3 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
        <img src={setup.qr} alt="QR code for your authenticator app" className="h-40 w-40 rounded-control" />
        <div className="min-w-0">
          <p className="text-micro text-ink-faint">Or enter this key:</p>
          <p className="break-all font-mono text-meta text-ink">{setup.secret}</p>
        </div>
      </div>
      <form className="mt-4 flex items-center gap-2" onSubmit={e => { e.preventDefault(); void confirm() }}>
        <input
          aria-label="Code from the app"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={e => { setCode(e.target.value) }}
          placeholder="123456"
          className={`${input} max-w-40`}
        />
        <button type="submit" disabled={busy || code.trim().length !== 6} className={primary}>
          {busy ? 'Checking…' : 'Confirm'}
        </button>
        {onCancel && <button type="button" onClick={onCancel} className="text-meta text-ink-faint hover:text-ink-muted">Cancel</button>}
      </form>
      {error && <p className="mt-2 text-meta text-error-4">{error}</p>}
    </div>
  )
}

/** Passkey and/or code entry; resolves through onVerified. */
function SecondFactorForm({ status, onVerified }: { status: MfaStatus | null; onVerified: (recoveryLeft?: number) => void }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const canPasskey = (status?.passkeys ?? 0) > 0 && passkeysSupported()
  // Until the status arrives, offer the code field: it takes either kind of code.
  const canCode = status === null || status.totp || status.recoveryCodesRemaining > 0

  const run = async (action: () => Promise<number | undefined>) => {
    setBusy(true)
    setError(null)
    try {
      onVerified(await action())
    } catch (err) {
      setError(messageOf(err))
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {canPasskey && (
        <button onClick={() => void run(async () => { await verifyWithPasskey(); return undefined })} disabled={busy} className={primary}>
          Use a passkey
        </button>
      )}
      {canCode && (
        <form className="flex flex-col gap-2" onSubmit={e => { e.preventDefault(); void run(async () => (await verifyCode(code)).recoveryCodesRemaining) }}>
          <input
            aria-label="Authentication code"
            autoComplete="one-time-code"
            value={code}
            onChange={e => { setCode(e.target.value) }}
            placeholder={status?.totp ? '6-digit code or a recovery code' : 'Recovery code'}
            className={input}
          />
          <button type="submit" disabled={busy || !code.trim()} className={canPasskey ? button : primary}>
            {busy ? 'Checking…' : 'Verify'}
          </button>
        </form>
      )}
      {error && <p className="text-meta text-error-4">{error}</p>}
    </div>
  )
}

function GateFrame({ title, children, onLogout }: { title: string; children: React.ReactNode; onLogout: () => void }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-page p-4">
      <div className="w-full max-w-md rounded-floating border border-edge bg-surface p-8">
        <div className="mb-4 flex items-center gap-2">
          <IconShieldCheck size={20} className="text-primary-5" />
          <h1 className="text-title text-ink">{title}</h1>
        </div>
        {children}
        <button onClick={onLogout} className="mt-6 w-full text-meta text-ink-faint transition hover:text-ink-muted">
          Sign out
        </button>
      </div>
    </div>
  )
}

/** Second step of sign-in. */
export function MfaChallengePage({ login, onVerified, onLogout }: { login: string; onVerified: () => void; onLogout: () => void }) {
  const [status, setStatus] = useState<MfaStatus | null>(null)
  const [lowCodes, setLowCodes] = useState<number | null>(null)

  useEffect(() => {
    fetchMfaStatus().then(setStatus).catch(() => { onLogout() })
  }, [onLogout])

  if (lowCodes !== null) {
    return (
      <GateFrame title="Signed in" onLogout={onLogout}>
        <p className="text-body text-ink">You used a recovery code; {lowCodes} left.</p>
        <p className="mt-1 text-meta text-ink-muted">Make new ones in Settings → Two-factor authentication when you can.</p>
        <button onClick={onVerified} className={`${primary} mt-4`}>Continue</button>
      </GateFrame>
    )
  }
  return (
    <GateFrame title="Two-factor authentication" onLogout={onLogout}>
      <p className="mb-4 text-meta text-ink-muted">
        Signed in with GitHub as <span className="font-mono">{login}</span>. Confirm it is you.
      </p>
      {status ? (
        <SecondFactorForm status={status} onVerified={left => { if (left !== undefined && left <= 3) setLowCodes(left); else onVerified() }} />
      ) : (
        <p className="text-body text-ink-muted">Loading…</p>
      )}
    </GateFrame>
  )
}

/** Enrollment required by the account's role (or a workspace). Ends with recovery codes. */
export function MfaEnrollPage({ login, onDone, onLogout }: { login: string; onDone: () => void; onLogout: () => void }) {
  const [status, setStatus] = useState<MfaStatus | null>(null)
  const [step, setStep] = useState<'choose' | 'totp' | 'codes'>('choose')
  const [codes, setCodes] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchMfaStatus().then(setStatus).catch(() => { onLogout() })
  }, [onLogout])

  const addPasskey = async () => {
    setError(null)
    try {
      await registerPasskey(defaultPasskeyLabel())
      // A passkey-only account still gets recovery codes.
      setCodes(await regenerateRecoveryCodes())
      setStep('codes')
    } catch (err) {
      setError(messageOf(err))
    }
  }
  const cancelTotp = useCallback(() => { setStep('choose') }, [])

  return (
    <GateFrame title="Set up two-factor authentication" onLogout={onLogout}>
      {step === 'codes' ? (
        <RecoveryCodesView codes={codes} onDone={onDone} />
      ) : step === 'totp' ? (
        <TotpSetup onDone={recovery => { setCodes(recovery); setStep('codes') }} onCancel={cancelTotp} />
      ) : (
        <>
          <p className="mb-4 text-meta text-ink-muted">
            <span className="font-mono">{login}</span>, your role requires a second factor before you can continue.
          </p>
          <div className="flex flex-col gap-2">
            {passkeysSupported() && (
              <button onClick={() => void addPasskey()} className={primary}>Add a passkey (this device)</button>
            )}
            {status?.totpAvailable && (
              <button onClick={() => { setStep('totp') }} className={button}>Use an authenticator app</button>
            )}
          </div>
          {error && <p className="mt-3 text-meta text-error-4">{error}</p>}
        </>
      )}
    </GateFrame>
  )
}

/** Settings panel: status, authenticator on/off, recovery codes. */
export function TwoFactorPanel() {
  const [status, setStatus] = useState<MfaStatus | null>(null)
  const [mode, setMode] = useState<'idle' | 'totp' | 'codes'>('idle')
  const [codes, setCodes] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(() => {
    fetchMfaStatus().then(setStatus).catch(() => { setError('Could not load two-factor settings.') })
  }, [])
  useEffect(() => { reload() }, [reload])
  const cancelTotp = useCallback(() => { setMode('idle') }, [])

  const run = async (action: () => Promise<void>) => {
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(messageOf(err))
    }
    reload()
  }

  if (!status) return error ? <p className="text-meta text-error-4">{error}</p> : null
  if (mode === 'totp') {
    return <TotpSetup onDone={recovery => { setCodes(recovery); setMode('codes') }} onCancel={cancelTotp} />
  }
  if (mode === 'codes') {
    return <RecoveryCodesView codes={codes} onDone={() => { setMode('idle'); reload() }} />
  }

  const enabled = status.totp || status.passkeys > 0
  const noCodesLeft = enabled && status.recoveryCodesRemaining === 0
  return (
    <div>
      <Rows>
        <Row
          label="Status"
          description={status.required
            ? 'Required by your role, so it stays on.'
            : 'Asked for after GitHub sign-in, and before sensitive changes.'}
          control={
            <span className={`rounded-control px-2 py-0.5 text-meta font-medium ${enabled ? 'bg-success-9/20 text-success-6' : 'bg-surface-raised text-ink-muted'}`}>
              {enabled ? 'On' : 'Off'}
            </span>
          }
        />
        <Row
          label="Authenticator app"
          description={status.totp
            ? 'Set up. Enter the 6-digit code it shows when asked.'
            : '1Password, Google Authenticator, Authy and others.'}
          control={
            status.totp ? (
              <button
                onClick={() => {
                  if (!window.confirm('Turn off the authenticator app?')) return
                  void run(disableTotp)
                }}
                className={dangerButton}
              >
                Turn off authenticator app
              </button>
            ) : status.totpAvailable ? (
              <button onClick={() => { setMode('totp') }} className={settingsButton}>Set up authenticator app</button>
            ) : (
              <span className="text-body text-ink-muted">Not available</span>
            )
          }
        />
        <Row
          label="Passkeys"
          description="Face ID, fingerprint or device PIN. Add and remove them under Devices & passkeys."
          control={<span className="text-body tabular-nums text-ink">{status.passkeys}</span>}
        />
        {enabled && (
          <Row
            label="Recovery codes"
            description={noCodesLeft
              ? 'None left. Make new ones so a lost device cannot lock you out.'
              : 'One-time codes for when you cannot use your other factors.'}
            control={
              <>
                <span className={`text-body tabular-nums ${noCodesLeft ? 'font-medium text-warning-5' : 'text-ink'}`}>
                  {status.recoveryCodesRemaining} left
                </span>
                <button
                  onClick={() => {
                    if (!window.confirm('Make new recovery codes? The old ones stop working.')) return
                    void run(async () => { setCodes(await regenerateRecoveryCodes()); setMode('codes') })
                  }}
                  className={settingsButton}
                >
                  New recovery codes
                </button>
              </>
            }
          />
        )}
      </Rows>
      {error && <p className="mt-4 text-meta text-error-4">{error}</p>}
    </div>
  )
}

/**
 * Mounted once at the root of the hosted app. Answers stepUpFetch: shows a
 * "confirm it's you" dialog and settles when the relay accepts a factor —
 * or, for an account without one, sends the browser through GitHub again.
 */
export function StepUpHost() {
  const [request, setRequest] = useState<{ method: StepUpMethod; status: MfaStatus | null } | null>(null)
  const settle = useRef<{ resolve: () => void; reject: (err: Error) => void } | null>(null)

  useEffect(() => {
    setStepUpHandler(method => new Promise<void>((resolve, reject) => {
      settle.current = { resolve, reject }
      setRequest({ method, status: null })
      if (method === 'mfa') {
        fetchMfaStatus()
          .then(status => { setRequest(current => current && { ...current, status }) })
          .catch(() => { /* the form still offers a code field */ })
      }
    }))
    return () => { setStepUpHandler(null) }
  }, [])

  if (!request) return null
  const finish = (err?: Error) => {
    const pending = settle.current
    settle.current = null
    setRequest(null)
    if (err) pending?.reject(err)
    else pending?.resolve()
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-page/80 p-4">
      <div role="dialog" aria-label="Confirm it's you" className="w-full max-w-sm rounded-floating border border-edge-strong bg-surface-raised p-6 shadow-floating">
        <h2 className="mb-1 text-title text-ink">Confirm it's you</h2>
        {request.method === 'github' ? (
          <>
            <p className="mb-4 text-meta text-ink-muted">This needs a recent sign-in. Sign in with GitHub again, then retry.</p>
            <button onClick={() => { window.location.assign('/api/auth/github/start') }} className={primary}>
              Sign in with GitHub
            </button>
          </>
        ) : (
          <>
            <p className="mb-4 text-meta text-ink-muted">This action needs a fresh two-factor check.</p>
            <SecondFactorForm status={request.status} onVerified={() => { finish() }} />
          </>
        )}
        <button onClick={() => { finish(new StepUpCancelled()) }} className="mt-4 w-full text-meta text-ink-faint transition hover:text-ink-muted">
          Cancel
        </button>
      </div>
    </div>
  )
}
