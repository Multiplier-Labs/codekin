/**
 * Devices & passkeys, as a section of Settings (hosted only).
 *
 * Two halves of the same story: "Link a device" mints a QR that signs a
 * phone in without typing anything, and the passkey list is what keeps those
 * devices signed in afterwards with a biometric prompt instead of a GitHub
 * round trip. Lazy-loaded by Settings so the local build never pulls it in.
 */

import { useState, useEffect, useCallback } from 'react'
import { IconQrcode, IconFingerprint, IconX } from '@tabler/icons-react'
import { toDataURL } from 'qrcode'
import {
  startDeviceLink,
  fetchDeviceLinkStatus,
  type DeviceLinkStart,
  type DeviceLinkStatus,
} from './deviceLink'
import {
  passkeysSupported,
  registerPasskey,
  fetchPasskeys,
  removePasskey,
  defaultPasskeyLabel,
  isPasskeyCancel,
  type Passkey,
} from './passkeys'

interface ActiveLink extends DeviceLinkStart {
  qrDataUrl: string
}

function LinkDevicePanel() {
  const [link, setLink] = useState<ActiveLink | null>(null)
  const [status, setStatus] = useState<DeviceLinkStatus>('pending')
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const generate = useCallback(async () => {
    setError(null)
    setCopied(false)
    try {
      const start = await startDeviceLink()
      const qrDataUrl = await toDataURL(start.linkUrl, { width: 220, margin: 2 })
      setStatus('pending')
      setLink({ ...start, qrDataUrl })
    } catch {
      setError('Could not create a link code. Try again.')
    }
  }, [])

  // Poll while the QR is showing so the dialog can confirm the claim.
  useEffect(() => {
    if (!link || status !== 'pending') return
    const timer = setInterval(() => {
      void fetchDeviceLinkStatus(link.requestId).then(next => {
        if (next === 'claimed' || next === 'expired') setStatus(next)
      })
    }, 2000)
    return () => { clearInterval(timer) }
  }, [link, status])

  if (!link) {
    return (
      <div>
        <button
          onClick={() => void generate()}
          className="flex items-center gap-2 rounded-control border border-edge px-3 py-2 text-body text-ink transition hover:bg-surface-raised"
        >
          <IconQrcode size={16} />
          Link a device
        </button>
        <p className="mt-1.5 text-micro text-ink-faint">
          Shows a QR code that signs another device in as you — nothing to type there.
        </p>
        {error && <p className="mt-2 text-meta text-error-4">{error}</p>}
      </div>
    )
  }

  return (
    <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
      <img
        src={link.qrDataUrl}
        alt="QR code for signing another device in"
        className="h-40 w-40 rounded-control"
      />
      <div className="min-w-0 flex-1">
        {status === 'pending' && (
          <>
            <p className="text-body text-ink">Scan with the other device's camera.</p>
            <p className="mt-1 text-meta text-ink-muted">
              The code works once and expires in 3 minutes. Anyone who scans it is signed in as
              you — keep it on your screen.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(link.linkUrl).then(() => { setCopied(true) })
                }}
                className="rounded-control border border-edge px-2.5 py-1 text-meta text-ink-muted transition hover:bg-surface-raised hover:text-ink"
              >
                {copied ? 'Copied' : 'Copy link'}
              </button>
              <button
                onClick={() => { setLink(null) }}
                className="rounded-control px-2 py-1 text-meta text-ink-faint transition hover:text-ink-muted"
              >
                Cancel
              </button>
            </div>
          </>
        )}
        {status === 'claimed' && (
          <p className="text-body text-success-6">Device linked ✓</p>
        )}
        {status === 'expired' && (
          <>
            <p className="text-body text-ink-muted">That code expired.</p>
            <button
              onClick={() => void generate()}
              className="mt-2 rounded-control border border-edge px-2.5 py-1 text-meta text-ink-muted transition hover:bg-surface-raised hover:text-ink"
            >
              Generate a new one
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function PasskeysPanel() {
  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const supported = passkeysSupported()

  useEffect(() => {
    let cancelled = false
    fetchPasskeys()
      .then(list => { if (!cancelled) setPasskeys(list) })
      .catch(() => { if (!cancelled) setPasskeys([]) })
    return () => { cancelled = true }
  }, [])

  const add = async () => {
    setBusy(true)
    setError(null)
    try {
      const passkey = await registerPasskey(defaultPasskeyLabel())
      setPasskeys(list => [...(list ?? []), passkey])
    } catch (err) {
      if (!isPasskeyCancel(err)) setError('Could not add a passkey on this device.')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    if (await removePasskey(id)) {
      setPasskeys(list => (list ?? []).filter(p => p.id !== id))
    }
  }

  if (passkeys === null) {
    return <p className="text-body text-ink-muted">Loading…</p>
  }

  return (
    <div>
      {passkeys.length > 0 && (
        <ul className="mb-3 flex flex-col gap-1.5">
          {passkeys.map(p => (
            <li
              key={p.id}
              className="flex items-center gap-3 rounded-control border border-edge bg-surface px-3 py-2"
            >
              <IconFingerprint size={16} className="flex-shrink-0 text-ink-muted" />
              <span className="truncate text-body text-ink">{p.label ?? 'Passkey'}</span>
              <span className="truncate text-meta text-ink-faint">
                {p.lastUsedAt ? `last used ${p.lastUsedAt.slice(0, 10)}` : `added ${p.createdAt.slice(0, 10)}`}
              </span>
              <button
                onClick={() => void remove(p.id)}
                title="Remove passkey"
                className="ml-auto flex-shrink-0 rounded-control p-1 text-ink-faint transition hover:bg-surface-raised hover:text-error-4"
              >
                <IconX size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {supported ? (
        <>
          <button
            onClick={() => void add()}
            disabled={busy}
            className="flex items-center gap-2 rounded-control border border-edge px-3 py-2 text-body text-ink transition hover:bg-surface-raised disabled:opacity-50"
          >
            <IconFingerprint size={16} />
            {busy ? 'Waiting for the authenticator…' : 'Add a passkey on this device'}
          </button>
          <p className="mt-1.5 text-micro text-ink-faint">
            Sign back in with Face ID, fingerprint, or your device PIN — no GitHub round trip.
          </p>
        </>
      ) : (
        <p className="text-meta text-ink-muted">This browser does not support passkeys.</p>
      )}
      {error && <p className="mt-2 text-meta text-error-4">{error}</p>}
    </div>
  )
}

export function DevicesSection() {
  return (
    <div className="flex flex-col gap-4">
      <LinkDevicePanel />
      <div className="border-t border-edge pt-4">
        <PasskeysPanel />
      </div>
    </div>
  )
}
