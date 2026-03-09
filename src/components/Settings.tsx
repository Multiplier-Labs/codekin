/**
 * Modal settings dialog for general configuration.
 *
 * Handles auth token and other settings.
 * Approvals management has moved to the right sidebar.
 */

import { useState, useEffect } from 'react'
import type { Settings as SettingsType } from '../types'
import { verifyToken, getRetentionDays, setRetentionDays as setRetentionDaysApi, getSupportProvider, setSupportProvider, type SupportProvider } from '../lib/ccApi'

const PROVIDER_LABELS: Record<SupportProvider, string> = {
  auto: 'Auto (first available)',
  groq: 'Groq',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  anthropic: 'Anthropic',
}

const PROVIDER_MODELS: Record<Exclude<SupportProvider, 'auto'>, string> = {
  groq: 'meta-llama/llama-4-scout-17b-16e-instruct',
  openai: 'gpt-5-nano',
  gemini: 'gemini-2.5-flash',
  anthropic: 'claude-haiku-4-5-20251001',
}

interface Props {
  open: boolean
  onClose: () => void
  settings: SettingsType
  onUpdate: (patch: Partial<SettingsType>) => void
}

export function Settings({ open, onClose, settings, onUpdate }: Props) {
  const [tokenInput, setTokenInput] = useState(settings.token)
  const [verifying, setVerifying] = useState(false)
  const [status, setStatus] = useState<'idle' | 'valid' | 'invalid'>('idle')
  const [retentionDays, setRetentionDays] = useState(7)
  const [supportProvider, setSupportProviderState] = useState<SupportProvider>('auto')
  const [availableProviders, setAvailableProviders] = useState<string[]>([])
  const [saveError, setSaveError] = useState<string | null>(null)

  // Re-sync token input when settings change or modal reopens
  useEffect(() => { setTokenInput(settings.token); setStatus('idle'); setSaveError(null) }, [settings.token, open]) // eslint-disable-line react-hooks/set-state-in-effect -- sync on reopen

  // Fetch server-side settings when modal opens
  useEffect(() => {
    if (!open || !settings.token) return
    getRetentionDays(settings.token).then(setRetentionDays).catch(() => {})
    getSupportProvider(settings.token).then(({ preferred, available }) => {
      setSupportProviderState(preferred)
      setAvailableProviders(available)
    }).catch(() => {})
  }, [open, settings.token])

  if (!open) return null

  async function handleVerify() {
    if (!tokenInput.trim()) return
    setVerifying(true)
    setStatus('idle')
    try {
      const valid = await verifyToken(tokenInput.trim())
      setStatus(valid ? 'valid' : 'invalid')
      if (valid) {
        onUpdate({ token: tokenInput.trim() })
      }
    } catch {
      setStatus('invalid')
    } finally {
      setVerifying(false)
    }
  }

  function handleSave() {
    onUpdate({ token: tokenInput.trim() })
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-md rounded-lg border border-neutral-10 bg-neutral-11 p-6 shadow-xl flex flex-col">
        <h2 className="mb-4 text-[19px] font-semibold text-neutral-2">Settings</h2>

        <label className="mb-1 block text-[15px] text-neutral-6">Claude Code Web Token</label>
        <div className="flex gap-2">
          <input
            type="password"
            value={tokenInput}
            onChange={e => { setTokenInput(e.target.value); setStatus('idle') }}
            placeholder="Enter your Claude Code web auth token"
            className="flex-1 rounded border border-neutral-9 bg-neutral-10 px-3 py-2 text-[15px] text-neutral-2 outline-none focus:border-primary-7"
            onKeyDown={e => e.key === 'Enter' && handleVerify()}
          />
          <button
            onClick={handleVerify}
            disabled={verifying || !tokenInput.trim()}
            className="rounded bg-primary-8 px-3 py-2 text-[15px] font-medium text-neutral-1 hover:bg-primary-7 disabled:opacity-50"
          >
            {verifying ? '...' : 'Verify'}
          </button>
        </div>
        {status === 'valid' && (
          <p className="mt-1 text-[13px] text-success-6">Token verified successfully</p>
        )}
        {status === 'invalid' && (
          <p className="mt-1 text-[13px] text-error-5">Invalid token</p>
        )}

        <label className="mb-1 mt-4 block text-[15px] text-neutral-6">Support LLM Provider</label>
        <select
          value={supportProvider}
          onChange={e => {
            const provider = e.target.value as SupportProvider
            setSupportProviderState(provider)
            setSupportProvider(settings.token, provider).catch(() => setSaveError('Failed to save provider setting'))
          }}
          className="rounded border border-neutral-9 bg-neutral-10 px-3 py-2 text-[15px] text-neutral-2 outline-none focus:border-primary-7"
        >
          {(Object.keys(PROVIDER_LABELS) as SupportProvider[]).map(key => {
            const isUnavailable = key !== 'auto' && !availableProviders.includes(key)
            return (
              <option key={key} value={key} disabled={isUnavailable}>
                {PROVIDER_LABELS[key]}{isUnavailable ? ' (no API key)' : ''}
              </option>
            )
          })}
        </select>
        {supportProvider !== 'auto' && (
          <div className="mt-2 rounded border border-neutral-9 bg-neutral-10/50 px-3 py-2">
            <span className="text-[13px] text-neutral-5">Model: </span>
            <span className="text-[13px] font-mono text-neutral-3">{PROVIDER_MODELS[supportProvider]}</span>
          </div>
        )}
        <p className="mt-1 text-[13px] text-neutral-6">Used for session naming and other background tasks</p>

        <label className="mb-1 mt-4 block text-[15px] text-neutral-6">Archived Session Retention</label>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            max={365}
            value={retentionDays}
            onChange={e => {
              const days = Math.max(1, Math.min(365, Number(e.target.value)))
              setRetentionDays(days)
              setRetentionDaysApi(settings.token, days).catch(() => setSaveError('Failed to save retention setting'))
            }}
            className="w-20 rounded border border-neutral-9 bg-neutral-10 px-3 py-2 text-[15px] text-neutral-2 outline-none focus:border-primary-7"
          />
          <span className="text-[15px] text-neutral-5">days</span>
        </div>
        <p className="mt-1 text-[13px] text-neutral-6">Auto-delete archived sessions older than this</p>

        <label className="mb-2 mt-4 block text-[15px] text-neutral-6">Theme</label>
        <div className="flex gap-2">
          <button
            onClick={() => onUpdate({ theme: 'dark' })}
            className={`rounded px-4 py-2 text-[15px] font-medium transition-colors ${
              settings.theme !== 'light'
                ? 'bg-primary-8 text-neutral-1'
                : 'border border-neutral-9 bg-neutral-10 text-neutral-3 hover:bg-neutral-9'
            }`}
          >
            Dark
          </button>
          <button
            onClick={() => onUpdate({ theme: 'light' })}
            className={`rounded px-4 py-2 text-[15px] font-medium transition-colors ${
              settings.theme === 'light'
                ? 'bg-primary-8 text-neutral-1'
                : 'border border-neutral-9 bg-neutral-10 text-neutral-3 hover:bg-neutral-9'
            }`}
          >
            Light
          </button>
        </div>

        {saveError && (
          <p className="mt-2 text-[13px] text-error-5">{saveError}</p>
        )}

        {/* Footer */}
        <div className="mt-4 flex justify-end gap-2 flex-shrink-0">
          {settings.token && (
            <button
              onClick={onClose}
              className="rounded px-4 py-2 text-[15px] text-neutral-6 hover:text-neutral-2"
            >
              Cancel
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={!tokenInput.trim()}
            className="rounded bg-primary-8 px-4 py-2 text-[15px] font-medium text-neutral-1 hover:bg-primary-7 disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
