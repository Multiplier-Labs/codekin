/**
 * Modal settings dialog for general configuration.
 *
 * Organized into logical sections: Authentication, Preferences, Integrations.
 * Handles auth token, theme, retention, support provider, and webhook config.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  IconKey, IconPalette, IconBrandGithub, IconCopy, IconCheck,
  IconChevronDown, IconChevronRight, IconCircleCheckFilled, IconCircleXFilled,
  IconRobot, IconArchive, IconBrain,
} from '@tabler/icons-react'
import type { Settings as SettingsType } from '../types'
import {
  verifyToken, getRetentionDays, setRetentionDays as setRetentionDaysApi,
  getSupportProvider, setSupportProvider, type SupportProvider,
  getWebhookConfig, getWebhookEvents, type WebhookConfigInfo,
} from '../lib/ccApi'

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

// ---------------------------------------------------------------------------
// Section header component
// ---------------------------------------------------------------------------
function SectionCard({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="settings-section-card rounded-lg border border-neutral-9/60 bg-neutral-10/30">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-neutral-9/40">
        <span className="text-neutral-5">{icon}</span>
        <h3 className="text-[13px] font-semibold uppercase tracking-wide text-neutral-5">{title}</h3>
      </div>
      <div className="px-4 py-4">
        {children}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Copy-to-clipboard button
// ---------------------------------------------------------------------------
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [text])

  return (
    <button
      onClick={handleCopy}
      className="rounded p-1.5 text-neutral-5 hover:bg-neutral-9 hover:text-neutral-2 transition-colors"
      title="Copy to clipboard"
    >
      {copied ? <IconCheck size={14} className="text-success-6" /> : <IconCopy size={14} />}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Webhook event status badge
// ---------------------------------------------------------------------------
function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    completed: 'bg-success-9/30 text-success-5',
    session_created: 'bg-primary-9/30 text-primary-5',
    processing: 'bg-yellow-900/30 text-yellow-500',
    error: 'bg-error-9/30 text-error-5',
    filtered: 'bg-neutral-9/50 text-neutral-5',
    duplicate: 'bg-neutral-9/50 text-neutral-5',
    received: 'bg-neutral-9/50 text-neutral-4',
  }
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${styles[status] || styles.received}`}>
      {status.replace('_', ' ')}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export function Settings({ open, onClose, settings, onUpdate }: Props) {
  const [tokenInput, setTokenInput] = useState(settings.token)
  const [verifying, setVerifying] = useState(false)
  const [status, setStatus] = useState<'idle' | 'valid' | 'invalid'>('idle')
  const [retentionDays, setRetentionDays] = useState(7)
  const [supportProvider, setSupportProviderState] = useState<SupportProvider>('auto')
  const [availableProviders, setAvailableProviders] = useState<string[]>([])
  const [saveError, setSaveError] = useState<string | null>(null)

  // Webhook state
  const [webhookConfig, setWebhookConfig] = useState<WebhookConfigInfo | null>(null)
  const [webhookEvents, setWebhookEvents] = useState<Array<{ id: string; repo: string; branch: string; workflow: string; status: string; receivedAt: string }>>([])
  const [webhookExpanded, setWebhookExpanded] = useState(false)
  const [eventsExpanded, setEventsExpanded] = useState(false)

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
    getWebhookConfig(settings.token).then(setWebhookConfig).catch(() => {})
    getWebhookEvents(settings.token).then(setWebhookEvents).catch(() => {})
  }, [open, settings.token])

  if (!open) return null

  const webhookUrl = `${location.protocol}//${location.host}/cc/api/webhooks/github`

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
      <div className="w-full max-w-2xl rounded-lg border border-neutral-10 bg-neutral-11 shadow-xl flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex-shrink-0 px-6 pt-5 pb-4 border-b border-neutral-10">
          <h2 className="text-[19px] font-semibold text-neutral-2">Settings</h2>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">

          {/* ── Authentication ── */}
          <SectionCard icon={<IconKey size={15} />} title="Authentication">
            <label className="mb-1 block text-[15px] text-neutral-4">Claude Code Web Token</label>
            <div className="flex gap-2">
              <input
                type="password"
                value={tokenInput}
                onChange={e => { setTokenInput(e.target.value); setStatus('idle') }}
                placeholder="Enter your auth token"
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
          </SectionCard>

          {/* ── Preferences ── */}
          <SectionCard icon={<IconPalette size={15} />} title="Preferences">
            <div className="grid grid-cols-2 gap-x-6 gap-y-4">
              {/* Theme */}
              <div>
                <label className="mb-1.5 block text-[15px] text-neutral-4">Theme</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => onUpdate({ theme: 'dark' })}
                    className={`rounded px-4 py-1.5 text-[15px] font-medium transition-colors ${
                      settings.theme !== 'light'
                        ? 'bg-primary-8 text-neutral-1'
                        : 'border border-neutral-9 bg-neutral-10 text-neutral-3 hover:bg-neutral-9'
                    }`}
                  >
                    Dark
                  </button>
                  <button
                    onClick={() => onUpdate({ theme: 'light' })}
                    className={`rounded px-4 py-1.5 text-[15px] font-medium transition-colors ${
                      settings.theme === 'light'
                        ? 'bg-primary-8 text-neutral-1'
                        : 'border border-neutral-9 bg-neutral-10 text-neutral-3 hover:bg-neutral-9'
                    }`}
                  >
                    Light
                  </button>
                </div>
              </div>

              {/* Archived Session Retention */}
              <div>
                <label className="mb-1.5 block text-[15px] text-neutral-4">
                  <span className="flex items-center gap-1.5">
                    <IconArchive size={14} className="text-neutral-5" />
                    Archived Session Retention
                  </span>
                </label>
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
              </div>

              {/* Support LLM Provider — full width */}
              <div className="col-span-2">
                <label className="mb-1.5 block text-[15px] text-neutral-4">
                  <span className="flex items-center gap-1.5">
                    <IconBrain size={14} className="text-neutral-5" />
                    Support LLM Provider
                  </span>
                </label>
                <select
                  value={supportProvider}
                  onChange={e => {
                    const provider = e.target.value as SupportProvider
                    setSupportProviderState(provider)
                    setSupportProvider(settings.token, provider).catch(() => setSaveError('Failed to save provider setting'))
                  }}
                  className="w-full rounded border border-neutral-9 bg-neutral-10 px-3 py-2 text-[15px] text-neutral-2 outline-none focus:border-primary-7"
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
                  <div className="mt-1.5 rounded border border-neutral-9 bg-neutral-10/50 px-3 py-1.5">
                    <span className="text-[13px] text-neutral-5">Model: </span>
                    <span className="text-[13px] font-mono text-neutral-3">{PROVIDER_MODELS[supportProvider]}</span>
                  </div>
                )}
                <p className="mt-1 text-[13px] text-neutral-6">Used for session naming and other background tasks</p>
              </div>
            </div>
          </SectionCard>

          {/* ── GitHub Webhooks ── */}
          <SectionCard icon={<IconBrandGithub size={15} />} title="GitHub Webhooks">
            {/* Status badge */}
            <div className="flex items-center gap-2 mb-3">
              {webhookConfig ? (
                webhookConfig.enabled ? (
                  <>
                    <IconCircleCheckFilled size={16} className="text-success-6" />
                    <span className="text-[15px] text-success-5 font-medium">Active</span>
                    <span className="text-[13px] text-neutral-6">
                      &middot; max {webhookConfig.maxConcurrentSessions} concurrent sessions
                    </span>
                  </>
                ) : (
                  <>
                    <IconCircleXFilled size={16} className="text-neutral-6" />
                    <span className="text-[15px] text-neutral-5">Disabled</span>
                  </>
                )
              ) : (
                <span className="text-[13px] text-neutral-6">Loading...</span>
              )}
            </div>

            {/* Description */}
            <p className="text-[13px] text-neutral-5 mb-3">
              Automatically create Claude sessions to diagnose and fix CI failures.
              When a GitHub Actions workflow fails, a webhook triggers Codekin to
              analyze logs, identify the issue, and propose a fix.
            </p>

            {/* Webhook URL */}
            <div className="mb-3">
              <label className="mb-1 block text-[12px] font-medium text-neutral-5 uppercase tracking-wide">Webhook URL</label>
              <div className="flex items-center gap-1 rounded border border-neutral-9 bg-neutral-10 px-3 py-2">
                <code className="flex-1 text-[13px] text-neutral-3 font-mono truncate select-all">{webhookUrl}</code>
                <CopyButton text={webhookUrl} />
              </div>
            </div>

            {/* Setup guide (collapsible) */}
            <button
              onClick={() => setWebhookExpanded(!webhookExpanded)}
              className="flex items-center gap-1.5 text-[13px] text-primary-6 hover:text-primary-5 mb-2 transition-colors"
            >
              {webhookExpanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
              Setup instructions
            </button>
            {webhookExpanded && (
              <div className="rounded border border-neutral-9 bg-neutral-10/50 px-4 py-3 mb-3 text-[13px] text-neutral-4 space-y-2.5">
                <div className="flex gap-2">
                  <span className="text-primary-6 font-semibold shrink-0">1.</span>
                  <span>
                    In your GitHub repo, go to <strong className="text-neutral-3">Settings &rarr; Webhooks &rarr; Add webhook</strong>
                  </span>
                </div>
                <div className="flex gap-2">
                  <span className="text-primary-6 font-semibold shrink-0">2.</span>
                  <span>
                    Set <strong className="text-neutral-3">Payload URL</strong> to the webhook URL above.
                    Set <strong className="text-neutral-3">Content type</strong> to <code className="text-neutral-3 bg-neutral-9/50 px-1 rounded">application/json</code>
                  </span>
                </div>
                <div className="flex gap-2">
                  <span className="text-primary-6 font-semibold shrink-0">3.</span>
                  <span>
                    Set a <strong className="text-neutral-3">Secret</strong> matching the server&apos;s <code className="text-neutral-3 bg-neutral-9/50 px-1 rounded">GITHUB_WEBHOOK_SECRET</code> env var
                  </span>
                </div>
                <div className="flex gap-2">
                  <span className="text-primary-6 font-semibold shrink-0">4.</span>
                  <span>
                    Under <strong className="text-neutral-3">&ldquo;Which events?&rdquo;</strong>, select <strong className="text-neutral-3">Let me select individual events</strong> and check <strong className="text-neutral-3">Workflow runs</strong>
                  </span>
                </div>
                <p className="text-[13px] text-neutral-6 pt-1 border-t border-neutral-9/50">
                  Failed workflow runs will automatically spawn a <IconRobot size={12} className="inline -mt-0.5" /> session that analyzes logs and proposes fixes.
                </p>
              </div>
            )}

            {/* Recent events (collapsible) */}
            {webhookEvents.length > 0 && (
              <>
                <button
                  onClick={() => setEventsExpanded(!eventsExpanded)}
                  className="flex items-center gap-1.5 text-[13px] text-primary-6 hover:text-primary-5 transition-colors"
                >
                  {eventsExpanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                  Recent events ({webhookEvents.length})
                </button>
                {eventsExpanded && (
                  <div className="mt-2 rounded border border-neutral-9 bg-neutral-10/50 divide-y divide-neutral-9/50 max-h-48 overflow-y-auto">
                    {webhookEvents.slice(0, 10).map(ev => (
                      <div key={ev.id} className="flex items-center gap-2 px-3 py-2 text-[12px]">
                        <IconRobot size={13} className="text-neutral-6 shrink-0" />
                        <span className="text-neutral-3 font-mono truncate flex-1">{ev.repo}</span>
                        <span className="text-neutral-5 truncate max-w-24">{ev.workflow}</span>
                        <StatusBadge status={ev.status} />
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {/* Disabled hint */}
            {webhookConfig && !webhookConfig.enabled && (
              <p className="mt-3 text-[13px] text-neutral-6">
                Set <code className="bg-neutral-9/50 px-1 rounded text-neutral-4">GITHUB_WEBHOOK_ENABLED=true</code> and <code className="bg-neutral-9/50 px-1 rounded text-neutral-4">GITHUB_WEBHOOK_SECRET</code> on the server to enable.
              </p>
            )}
          </SectionCard>
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 px-6 py-4 border-t border-neutral-10 flex items-center justify-between">
          <div>
            {saveError && (
              <p className="text-[13px] text-error-5">{saveError}</p>
            )}
          </div>
          <div className="flex gap-2">
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
    </div>
  )
}
