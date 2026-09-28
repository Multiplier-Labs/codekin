/**
 * GitHub webhooks (machine setting): server status, the webhook URL, a
 * per-repo integration health check with an automatic setup wizard, manual
 * instructions and recent events. Loads its state when it mounts.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  IconCopy, IconCheck, IconChevronDown, IconChevronRight, IconCircleCheckFilled, IconCircleXFilled,
  IconRobot, IconRefresh, IconAlertTriangle, IconPlugConnected, IconPlayerPlay, IconWand,
} from '@tabler/icons-react'
import {
  getWebhookConfig, getWebhookEvents, type WebhookConfigInfo,
  getIntegrationHealth, previewWebhookSetup, applyWebhookSetup, testWebhookDelivery, webhookEndpointUrl,
  type HealthCheckResult, type SetupPreview,
} from '../../lib/ccApi'

// ---------------------------------------------------------------------------
// Copy-to-clipboard button
// ---------------------------------------------------------------------------
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [text])

  return (
    <button
      onClick={handleCopy}
      className="rounded-control p-1.5 text-ink-muted hover:bg-surface-raised hover:text-ink transition-colors"
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
    processing: 'bg-warning-9/30 text-warning-5',
    error: 'bg-error-9/30 text-error-5',
    filtered: 'bg-edge/50 text-ink-muted',
    duplicate: 'bg-edge/50 text-ink-muted',
    received: 'bg-edge/50 text-ink-muted',
  }
  return (
    <span className={`rounded-control px-1.5 py-0.5 text-micro font-medium ${styles[status] || styles.received}`}>
      {status.replace('_', ' ')}
    </span>
  )
}

export function WebhooksSection({ token }: { token: string }) {
  // Webhook state
  const [webhookConfig, setWebhookConfig] = useState<WebhookConfigInfo | null>(null)
  const [webhookEvents, setWebhookEvents] = useState<Array<{ id: string; repo: string; branch: string; workflow: string; status: string; receivedAt: string }>>([])
  const [webhookExpanded, setWebhookExpanded] = useState(false)
  const [eventsExpanded, setEventsExpanded] = useState(false)

  // Health check state
  const [healthRepo, setHealthRepo] = useState('')
  const [healthResult, setHealthResult] = useState<HealthCheckResult | null>(null)
  const [healthLoading, setHealthLoading] = useState(false)
  const [healthError, setHealthError] = useState<string | null>(null)

  // Setup wizard state
  const [wizardStep, setWizardStep] = useState<'idle' | 'preview' | 'applying' | 'done'>('idle')
  const [setupPreview, setSetupPreview] = useState<SetupPreview | null>(null)
  const [setupError, setSetupError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [testLoading, setTestLoading] = useState(false)

  useEffect(() => {
    if (!token) return
    getWebhookConfig(token).then(setWebhookConfig).catch(() => {})
    getWebhookEvents(token).then(setWebhookEvents).catch(() => {})
  }, [token])

  const webhookUrl = webhookEndpointUrl()

  return (
    <>
      {/* Server config status */}
      <div className="flex items-center gap-2 mb-3">
        {webhookConfig ? (
          webhookConfig.enabled ? (
            <>
              <IconCircleCheckFilled size={16} className="text-success-6" />
              <span className="text-body text-success-5 font-medium">Active</span>
              <span className="text-meta text-ink-muted">
                &middot; max {webhookConfig.maxConcurrentSessions} concurrent sessions
              </span>
            </>
          ) : (
            <>
              <IconCircleXFilled size={16} className="text-ink-faint" />
              <span className="text-body text-ink-muted">Disabled</span>
            </>
          )
        ) : (
          <span className="text-body text-ink-muted">Loading...</span>
        )}
      </div>

      <p className="text-body text-ink-muted mb-3">
        Automatically review PRs and diagnose CI failures via GitHub webhooks.
      </p>

      {/* Webhook URL */}
      <div className="mb-4">
        <label className="mb-1 block text-meta font-medium text-ink-muted uppercase tracking-wide">Webhook URL</label>
        <div className="flex items-center gap-1 rounded-control border border-edge bg-surface px-3 py-2">
          <code className="flex-1 text-meta text-ink font-mono truncate select-all">{webhookUrl}</code>
          <CopyButton text={webhookUrl} />
        </div>
      </div>

      {/* ── Integration Health Check ── */}
      <div className="border-t border-edge pt-4 mb-4">
        <div className="flex items-center gap-2 mb-3">
          <IconPlugConnected size={14} className="text-ink-muted" />
          <span className="text-meta font-semibold uppercase tracking-wide text-ink-muted">Integration Health</span>
        </div>

        {/* Repo input */}
        <div className="flex gap-2 mb-3">
          <input
            type="text"
            placeholder="owner/repo"
            value={healthRepo}
            onChange={e => setHealthRepo(e.target.value)}
            className="flex-1 rounded-control border border-edge bg-surface px-3 py-2 text-body text-ink outline-none focus:border-primary-7 font-mono placeholder:text-ink-faint"
          />
          <button
            onClick={async () => {
              if (!healthRepo.trim() || !token) return
              setHealthLoading(true)
              setHealthError(null)
              setHealthResult(null)
              try {
                const result = await getIntegrationHealth(token, healthRepo.trim(), webhookUrl)
                setHealthResult(result)
              } catch (err) {
                setHealthError(err instanceof Error ? err.message : 'Health check failed')
              } finally {
                setHealthLoading(false)
              }
            }}
            disabled={!healthRepo.trim() || healthLoading}
            className="flex items-center gap-1.5 rounded-control bg-primary-8 px-3 py-2 text-body font-medium text-on-primary hover:bg-primary-7 disabled:opacity-50 transition-colors"
          >
            {healthLoading ? (
              <IconRefresh size={14} className="animate-spin" />
            ) : (
              <IconRefresh size={14} />
            )}
            Check
          </button>
        </div>

        {/* Health error */}
        {healthError && (
          <p className="text-body text-error-5 mb-3">{healthError}</p>
        )}

        {/* Health results */}
        {healthResult && (
          <div className="space-y-2 mb-3">
            {/* Overall badge */}
            <div className="flex items-center gap-2 mb-2">
              {healthResult.overall === 'healthy' && <IconCircleCheckFilled size={16} className="text-success-6" />}
              {healthResult.overall === 'degraded' && <IconAlertTriangle size={16} className="text-warning-5" />}
              {healthResult.overall === 'broken' && <IconCircleXFilled size={16} className="text-error-5" />}
              {healthResult.overall === 'unconfigured' && <IconCircleXFilled size={16} className="text-ink-faint" />}
              <span className={`text-body font-medium ${
                healthResult.overall === 'healthy' ? 'text-success-5' :
                healthResult.overall === 'degraded' ? 'text-warning-5' :
                healthResult.overall === 'broken' ? 'text-error-5' :
                'text-ink-muted'
              }`}>
                {healthResult.overall === 'healthy' ? 'Healthy' :
                 healthResult.overall === 'degraded' ? 'Degraded' :
                 healthResult.overall === 'broken' ? 'Broken' :
                 'Not Configured'}
              </span>
            </div>

            {/* Per-check rows */}
            <div className="rounded-control border border-edge bg-surface divide-y divide-edge">
              {Object.entries(healthResult.checks).map(([key, check]) => (
                <div key={key} className="flex items-start gap-2.5 px-3 py-2.5">
                  {check.ok ? (
                    <IconCircleCheckFilled size={14} className="text-success-6 mt-0.5 shrink-0" />
                  ) : (
                    <IconCircleXFilled size={14} className="text-error-5 mt-0.5 shrink-0" />
                  )}
                  <div className="min-w-0">
                    <span className="text-meta font-medium text-ink-muted uppercase tracking-wide">
                      {key === 'ghCli' ? 'GitHub CLI' :
                       key === 'config' ? 'Server Config' :
                       key === 'webhook' ? 'GitHub Webhook' :
                       'Deliveries'}
                    </span>
                    <p className="text-body text-ink-muted mt-0.5">{check.message}</p>
                  </div>
                </div>
              ))}
            </div>

            {/* Setup wizard trigger */}
            {healthResult.checks.ghCli.ok && (healthResult.overall === 'broken' || healthResult.overall === 'degraded') && !healthResult.checks.webhook.ok && wizardStep === 'idle' && (
              <button
                onClick={async () => {
                  setSetupError(null)
                  setWizardStep('preview')
                  try {
                    const { preview } = await previewWebhookSetup(token, healthRepo.trim(), webhookUrl)
                    setSetupPreview(preview)
                  } catch (err) {
                    setSetupError(err instanceof Error ? err.message : 'Preview failed')
                    setWizardStep('idle')
                  }
                }}
                className="flex items-center gap-1.5 rounded-control bg-primary-8 px-3 py-2 text-body font-medium text-on-primary hover:bg-primary-7 transition-colors mt-2"
              >
                <IconWand size={14} />
                Set up automatically
              </button>
            )}

            {/* Test delivery button (when webhook exists) */}
            {healthResult.checks.webhook.ok && wizardStep === 'idle' && (
              <button
                onClick={async () => {
                  setTestLoading(true)
                  setTestResult(null)
                  try {
                    const result = await testWebhookDelivery(token, healthRepo.trim(), webhookUrl)
                    setTestResult(result)
                  } catch (err) {
                    setTestResult({ success: false, message: err instanceof Error ? err.message : 'Test failed' })
                  } finally {
                    setTestLoading(false)
                  }
                }}
                disabled={testLoading}
                className="flex items-center gap-1.5 rounded-control border border-edge bg-surface-raised px-3 py-2 text-body text-ink hover:bg-edge disabled:opacity-50 transition-colors mt-2"
              >
                {testLoading ? <IconRefresh size={14} className="animate-spin" /> : <IconPlayerPlay size={14} />}
                Test delivery
              </button>
            )}

            {/* Test result */}
            {testResult && (
              <div className={`rounded-control border px-3 py-2 text-body mt-2 ${
                testResult.success
                  ? 'border-success-9/50 bg-success-9/10 text-success-5'
                  : 'border-error-9/50 bg-error-9/10 text-error-5'
              }`}>
                {testResult.message}
              </div>
            )}
          </div>
        )}

        {/* Setup wizard */}
        {wizardStep !== 'idle' && (
          <div className="rounded-control border border-primary-9/30 bg-primary-9/5 px-4 py-3 mb-3 space-y-3">
            <div className="flex items-center gap-2">
              <IconWand size={14} className="text-primary-6" />
              <span className="text-body font-medium text-primary-5">Webhook Setup</span>
            </div>

            {/* Preview step */}
            {wizardStep === 'preview' && setupPreview && (
              <>
                <div className="text-body text-ink-muted space-y-1.5">
                  <p>
                    {setupPreview.action === 'create'
                      ? `Will create a new webhook on ${healthRepo}:`
                      : `Will update the existing webhook on ${healthRepo}:`}
                  </p>
                  <div className="rounded-control bg-surface px-3 py-2 font-mono text-meta text-ink space-y-1">
                    <div>URL: {setupPreview.proposed.url}</div>
                    <div>Events: {setupPreview.proposed.events.join(', ')}</div>
                    <div>Active: {setupPreview.proposed.active ? 'yes' : 'no'}</div>
                  </div>
                  {setupPreview.changes && setupPreview.changes.length > 0 && (
                    <ul className="list-disc list-inside text-meta text-ink-muted">
                      {setupPreview.changes.map((c, i) => <li key={i}>{c}</li>)}
                    </ul>
                  )}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={async () => {
                      setWizardStep('applying')
                      setSetupError(null)
                      try {
                        await applyWebhookSetup(token, healthRepo.trim(), webhookUrl)
                        setWizardStep('done')
                        // Re-run health check
                        const result = await getIntegrationHealth(token, healthRepo.trim(), webhookUrl)
                        setHealthResult(result)
                      } catch (err) {
                        setSetupError(err instanceof Error ? err.message : 'Setup failed')
                        setWizardStep('preview')
                      }
                    }}
                    className="rounded-control bg-primary-8 px-3 py-1.5 text-body font-medium text-on-primary hover:bg-primary-7 transition-colors"
                  >
                    Apply
                  </button>
                  <button
                    onClick={() => { setWizardStep('idle'); setSetupPreview(null); setSetupError(null) }}
                    className="rounded-control px-3 py-1.5 text-body text-ink-muted hover:text-ink transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}

            {/* Applying step */}
            {wizardStep === 'applying' && (
              <div className="flex items-center gap-2 text-body text-ink-muted">
                <IconRefresh size={14} className="animate-spin text-primary-6" />
                Configuring webhook on GitHub...
              </div>
            )}

            {/* Done step */}
            {wizardStep === 'done' && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-body text-success-5">
                  <IconCircleCheckFilled size={14} />
                  Webhook configured successfully.
                </div>
                <button
                  onClick={() => { setWizardStep('idle'); setSetupPreview(null) }}
                  className="rounded-control px-3 py-1.5 text-body text-ink-muted hover:text-ink transition-colors"
                >
                  Dismiss
                </button>
              </div>
            )}

            {/* Setup error */}
            {setupError && (
              <p className="text-body text-error-5">{setupError}</p>
            )}
          </div>
        )}
      </div>

      {/* Setup guide (collapsible) — context-aware */}
      <button
        onClick={() => setWebhookExpanded(!webhookExpanded)}
        className="flex items-center gap-1.5 text-body text-primary-6 hover:text-primary-5 mb-2 transition-colors"
      >
        {webhookExpanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
        Manual setup instructions
      </button>
      {webhookExpanded && (
        <div className="rounded-control border border-edge bg-surface px-4 py-3 mb-3 text-body text-ink-muted space-y-2.5">
          {(!healthResult || !healthResult.checks.config.ok) && (
            <div className="flex gap-2">
              <span className="text-primary-6 font-semibold shrink-0">1.</span>
              <span>
                Set <code className="text-ink bg-edge/50 px-1 rounded-control">GITHUB_WEBHOOK_ENABLED=true</code> and <code className="text-ink bg-edge/50 px-1 rounded-control">GITHUB_WEBHOOK_SECRET=&lt;your-secret&gt;</code> on the server, then restart.
              </span>
            </div>
          )}
          <div className="flex gap-2">
            <span className="text-primary-6 font-semibold shrink-0">{!healthResult || !healthResult.checks.config.ok ? '2' : '1'}.</span>
            <span>
              In your GitHub repo, go to <strong className="text-ink">Settings &rarr; Webhooks &rarr; Add webhook</strong>
            </span>
          </div>
          <div className="flex gap-2">
            <span className="text-primary-6 font-semibold shrink-0">{!healthResult || !healthResult.checks.config.ok ? '3' : '2'}.</span>
            <span>
              Set <strong className="text-ink">Payload URL</strong> to the webhook URL above.
              Set <strong className="text-ink">Content type</strong> to <code className="text-ink bg-edge/50 px-1 rounded-control">application/json</code>
            </span>
          </div>
          <div className="flex gap-2">
            <span className="text-primary-6 font-semibold shrink-0">{!healthResult || !healthResult.checks.config.ok ? '4' : '3'}.</span>
            <span>
              Set a <strong className="text-ink">Secret</strong> matching the server&apos;s <code className="text-ink bg-edge/50 px-1 rounded-control">GITHUB_WEBHOOK_SECRET</code>
            </span>
          </div>
          <div className="flex gap-2">
            <span className="text-primary-6 font-semibold shrink-0">{!healthResult || !healthResult.checks.config.ok ? '5' : '4'}.</span>
            <span>
              Under <strong className="text-ink">&ldquo;Which events?&rdquo;</strong>, select <strong className="text-ink">Let me select individual events</strong> and check <strong className="text-ink">Workflow runs</strong> and <strong className="text-ink">Pull requests</strong>
            </span>
          </div>
          <p className="text-body text-ink-muted pt-1 border-t border-edge">
            Webhook events will automatically spawn <IconRobot size={12} className="inline -mt-0.5" /> sessions for PR reviews and CI failure analysis.
          </p>
        </div>
      )}

      {/* Recent events (collapsible) */}
      {webhookEvents.length > 0 && (
        <>
          <button
            onClick={() => setEventsExpanded(!eventsExpanded)}
            className="flex items-center gap-1.5 text-body text-primary-6 hover:text-primary-5 transition-colors"
          >
            {eventsExpanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
            Recent events ({webhookEvents.length})
          </button>
          {eventsExpanded && (
            <div className="mt-2 rounded-control border border-edge bg-surface divide-y divide-edge max-h-48 overflow-y-auto">
              {webhookEvents.slice(0, 10).map(ev => (
                <div key={ev.id} className="flex items-center gap-2 px-3 py-2 text-meta">
                  <IconRobot size={13} className="text-ink-faint shrink-0" />
                  <span className="text-ink font-mono truncate flex-1">{ev.repo}</span>
                  <span className="text-ink-muted truncate max-w-24">{ev.workflow}</span>
                  <StatusBadge status={ev.status} />
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Disabled hint */}
      {webhookConfig && !webhookConfig.enabled && !healthResult && (
        <p className="mt-3 text-body text-ink-muted">
          Set <code className="bg-edge/50 px-1 rounded-control text-ink-muted">GITHUB_WEBHOOK_ENABLED=true</code> and <code className="bg-edge/50 px-1 rounded-control text-ink-muted">GITHUB_WEBHOOK_SECRET</code> on the server to enable.
        </p>
      )}
    </>
  )
}
