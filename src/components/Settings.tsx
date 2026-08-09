/**
 * Modal settings dialog for general configuration.
 *
 * Organized into logical sections: Authentication, Preferences, Integrations.
 * Handles auth token, theme, retention, repos path, and webhook config.
 */

import { useState, useEffect, useCallback, useMemo, Suspense, lazy } from 'react'
import {
  IconKey, IconPalette, IconBrandGithub, IconCopy, IconCheck,
  IconChevronDown, IconChevronRight, IconCircleCheckFilled, IconCircleXFilled,
  IconRobot, IconArchive, IconGitBranch, IconRefresh, IconAlertTriangle,
  IconPlugConnected, IconPlayerPlay, IconWand, IconShieldLock, IconServer2,
} from '@tabler/icons-react'
import type { Settings as SettingsType, PermissionMode, Repo } from '../types'
import { PERMISSION_MODES } from '../types'
import {
  verifyToken, getRetentionDays, setRetentionDays as setRetentionDaysApi,
  getWebhookConfig, getWebhookEvents, type WebhookConfigInfo,
  getReposPath, setReposPath as setReposPathApi,
  getWorktreePrefix, setWorktreePrefix as setWorktreePrefixApi,
  getQueueMessages, setQueueMessages as setQueueMessagesApi,
  setAgentName as setAgentNameApi,
  getIntegrationHealth, previewWebhookSetup, applyWebhookSetup, testWebhookDelivery,
  getRepoApprovals, bulkRemoveRepoApprovals, webhookEndpointUrl,
  type HealthCheckResult, type SetupPreview,
} from '../lib/ccApi'
import { FolderPicker } from './FolderPicker'

/** localStorage key holding the permission mode new sessions start with. */
const PERMISSION_MODE_KEY = 'claude-permission-mode'

/** Aggregate of every repo's auto-approval rules. */
interface ApprovalSummary {
  /** Total rules (tools + commands + patterns) across all repos. */
  total: number
  /** How many repos contributed at least one rule. */
  repoCount: number
  /** Per-repo revoke payloads, keyed by workingDir. */
  byRepo: Array<{ workingDir: string; items: Array<{ tool?: string; command?: string; pattern?: string }> }>
}


interface Props {
  open: boolean
  onClose: () => void
  settings: SettingsType
  onUpdate: (patch: Partial<SettingsType>) => void
  isMobile?: boolean
  autoWorktree?: boolean
  onAutoWorktreeChange?: (enabled: boolean) => void
  agentName?: string
  onAgentNameChange?: (name: string) => void
  /** Repos used to aggregate app-wide approval counts. */
  repos?: Repo[]
  /** Hosted only: machine this workspace is connected to. */
  hostedMachineId?: string
  /** Hosted only: connect to another machine. Absent in the local build. */
  onSwitchMachine?: (machine: import('../hosted/machines').Machine) => void
}

/**
 * Hosted only: the machine list, which used to be a separate view you landed
 * on. Lazy so the local build never loads it.
 */
const MachinesSection = lazy(() => import('../hosted/MachinesSection').then(m => ({ default: m.MachinesSection })))

// ---------------------------------------------------------------------------
// Section header component
// ---------------------------------------------------------------------------
function SectionCard({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="settings-section-card rounded-lg border border-edge bg-surface">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-edge">
        <span className="text-ink-muted">{icon}</span>
        <h3 className="text-meta font-semibold uppercase tracking-wide text-ink-muted">{title}</h3>
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

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export function Settings({ open, onClose, settings, onUpdate, isMobile = false, autoWorktree = false, onAutoWorktreeChange, agentName = 'Joe', onAgentNameChange, repos = [], hostedMachineId = '', onSwitchMachine }: Props) {
  const [tokenInput, setTokenInput] = useState(settings.token)
  const [verifying, setVerifying] = useState(false)
  const [status, setStatus] = useState<'idle' | 'valid' | 'invalid'>('idle')
  const [retentionDays, setRetentionDays] = useState(7)
  const [reposPath, setReposPath] = useState('')
  const [worktreePrefix, setWorktreePrefix] = useState('wt/')
  const [queueMessages, setQueueMessages] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Permissions state (app-wide default + aggregated approvals)
  const [defaultPermissionMode, setDefaultPermissionMode] = useState<PermissionMode>(
    () => (localStorage.getItem(PERMISSION_MODE_KEY) as PermissionMode | null) ?? 'acceptEdits',
  )
  const [approvalSummary, setApprovalSummary] = useState<ApprovalSummary | null>(null)
  const [approvalsLoading, setApprovalsLoading] = useState(false)
  const [approvalsError, setApprovalsError] = useState(false)
  const [revoking, setRevoking] = useState(false)
  const [approvalsNonce, setApprovalsNonce] = useState(0)

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

  // Re-sync token input when settings change or modal reopens
  useEffect(() => { setTokenInput(settings.token); setStatus('idle'); setSaveError(null) }, [settings.token, open]) // eslint-disable-line react-hooks/set-state-in-effect -- sync on reopen

  // Re-read the app-wide default permission mode each time the modal opens —
  // the composer writes the same localStorage key when a session switches mode.
  useEffect(() => {
    if (!open) return
    setDefaultPermissionMode((localStorage.getItem(PERMISSION_MODE_KEY) as PermissionMode | null) ?? 'acceptEdits')
  }, [open])

  // Stable list of repo working directories (the `repos` prop is a fresh array
  // on every parent render, so key on its contents instead of its identity).
  const repoDirsKey = repos.map(r => r.workingDir).filter(Boolean).sort().join('\n')
  const repoDirs = useMemo(() => (repoDirsKey ? repoDirsKey.split('\n') : []), [repoDirsKey])

  // Aggregate auto-approval rules across every known repo.
  useEffect(() => {
    if (!open || !settings.token || repoDirs.length === 0) return
    let cancelled = false
    setApprovalsLoading(true)
    setApprovalsError(false)
    void Promise.all(
      repoDirs.map(async workingDir => {
        try {
          const a = await getRepoApprovals(settings.token, workingDir)
          const items: Array<{ tool?: string; command?: string; pattern?: string }> = [
            ...a.tools.map(tool => ({ tool })),
            ...a.commands.map(command => ({ command })),
            ...a.patterns.map(pattern => ({ pattern })),
          ]
          return { workingDir, items }
        } catch {
          return null
        }
      }),
    ).then(results => {
      if (cancelled) return
      const loaded = results.filter((r): r is { workingDir: string; items: Array<{ tool?: string; command?: string; pattern?: string }> } => r !== null)
      if (loaded.length === 0) {
        setApprovalSummary(null)
        setApprovalsError(true)
        return
      }
      const byRepo = loaded.filter(r => r.items.length > 0)
      setApprovalSummary({
        total: byRepo.reduce((n, r) => n + r.items.length, 0),
        repoCount: byRepo.length,
        byRepo,
      })
    }).finally(() => { if (!cancelled) setApprovalsLoading(false) })
    return () => { cancelled = true }
  }, [open, settings.token, repoDirs, approvalsNonce])

  // Fetch server-side settings when modal opens
  useEffect(() => {
    if (!open || !settings.token) return
    getRetentionDays(settings.token).then(setRetentionDays).catch(() => {})
    getReposPath(settings.token).then(setReposPath).catch(() => {})
    getWorktreePrefix(settings.token).then(setWorktreePrefix).catch(() => {})
    getQueueMessages(settings.token).then(setQueueMessages).catch(() => {})
    getWebhookConfig(settings.token).then(setWebhookConfig).catch(() => {})
    getWebhookEvents(settings.token).then(setWebhookEvents).catch(() => {})
  }, [open, settings.token])

  if (!open) return null

  const webhookUrl = webhookEndpointUrl()

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

  /**
   * Set the permission mode new sessions start with. Dangerous modes are
   * gated behind the same confirmation the composer uses.
   */
  function handleDefaultPermissionModeSelect(mode: PermissionMode) {
    const entry = PERMISSION_MODES.find(m => m.id === mode)
    if (entry?.dangerous) {
      const confirmed = window.confirm(
        `Warning: "${entry.label}" will accept ALL tool calls without asking.\n\n` +
        'This includes file writes, bash commands, and web requests. ' +
        'Only use this if you fully trust the task.\n\n' +
        'Every new session will start in this mode. Are you sure?'
      )
      if (!confirmed) return
    }
    localStorage.setItem(PERMISSION_MODE_KEY, mode)
    setDefaultPermissionMode(mode)
  }

  /** Revoke every auto-approval rule in every repo, one bulk call per repo. */
  async function handleRevokeAllApprovals() {
    if (!approvalSummary || approvalSummary.total === 0) return
    const confirmed = window.confirm(
      `Revoke all ${approvalSummary.total} approved pattern${approvalSummary.total !== 1 ? 's' : ''} ` +
      `across ${approvalSummary.repoCount} repo${approvalSummary.repoCount !== 1 ? 's' : ''}?\n\n` +
      'Claude will ask for permission again the next time it uses these tools.'
    )
    if (!confirmed) return
    setRevoking(true)
    try {
      await Promise.all(
        approvalSummary.byRepo.map(r => bulkRemoveRepoApprovals(settings.token, r.workingDir, r.items)),
      )
    } catch {
      setSaveError('Failed to revoke some approvals')
    } finally {
      setRevoking(false)
      setApprovalsNonce(n => n + 1)
    }
  }

  const activePermissionMode = PERMISSION_MODES.find(m => m.id === defaultPermissionMode)
  const dangerousDefault = activePermissionMode?.dangerous === true

  return (
    <div className={`fixed inset-0 z-50 flex bg-black/60 ${isMobile ? 'items-end' : 'items-center justify-center'}`}>
      <div className={`w-full bg-surface-raised border border-edge-strong shadow-floating flex flex-col ${isMobile ? 'max-h-[95vh] rounded-t-floating' : 'max-w-2xl rounded-floating max-h-[85vh]'}`}>
        {/* Header */}
        <div className="flex-shrink-0 px-6 pt-5 pb-4 border-b border-edge">
          <h2 className="text-head font-semibold text-ink">Settings</h2>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">

          {/* ── Machines (hosted only) ──
              First, because it says which machine everything below applies to. */}
          {onSwitchMachine && (
            <SectionCard icon={<IconServer2 size={15} />} title="Machines">
              <Suspense fallback={<p className="text-body text-ink-muted">Loading…</p>}>
                <MachinesSection
                  currentMachineId={hostedMachineId}
                  onSwitch={machine => { onClose(); onSwitchMachine(machine) }}
                />
              </Suspense>
            </SectionCard>
          )}

          {/* ── Authentication ── */}
          <SectionCard icon={<IconKey size={15} />} title="Authentication">
            <label className="mb-1 block text-body text-ink-muted">Claude Code Web Token</label>
            <div className="flex gap-2">
              <input
                type="password"
                value={tokenInput}
                onChange={e => { setTokenInput(e.target.value); setStatus('idle') }}
                placeholder="Enter your auth token"
                className="flex-1 rounded-control border border-edge bg-surface px-3 py-2 text-body text-ink outline-none focus:border-primary-7"
                onKeyDown={e => e.key === 'Enter' && handleVerify()}
              />
              <button
                onClick={handleVerify}
                disabled={verifying || !tokenInput.trim()}
                className="rounded-control bg-primary-8 px-3 py-2 text-body font-medium text-on-primary hover:bg-primary-7 disabled:opacity-50"
              >
                {verifying ? '...' : 'Verify'}
              </button>
            </div>
            {status === 'valid' && (
              <p className="mt-1 text-body text-success-6">Token verified successfully</p>
            )}
            {status === 'invalid' && (
              <p className="mt-1 text-body text-error-5">Invalid token</p>
            )}
          </SectionCard>

          {/* ── Preferences ── */}
          <SectionCard icon={<IconPalette size={15} />} title="Preferences">
            <div className="space-y-5">

              {/* ─ Agent Name ─ */}
              <div>
                <label className="mb-1.5 block text-body text-ink-muted">
                  <span className="flex items-center gap-1.5">
                    <IconRobot size={14} className="text-ink-muted" />
                    Agent Name
                  </span>
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={agentName}
                    onChange={e => {
                      const val = e.target.value
                      onAgentNameChange?.(val)
                    }}
                    onBlur={e => {
                      const val = e.target.value.trim()
                      if (val && val !== agentName) {
                        setAgentNameApi(settings.token, val).then(saved => onAgentNameChange?.(saved)).catch(() => setSaveError('Failed to save agent name'))
                      }
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        const val = (e.target as HTMLInputElement).value.trim()
                        if (val) {
                          setAgentNameApi(settings.token, val).then(saved => onAgentNameChange?.(saved)).catch(() => setSaveError('Failed to save agent name'))
                        }
                      }
                    }}
                    placeholder="Joe"
                    maxLength={30}
                    className="w-40 rounded-control border border-edge bg-surface px-3 py-2 text-body text-ink outline-none focus:border-primary-7"
                  />
                </div>
                <p className="mt-1 text-body text-ink-muted">Display name for the orchestrator agent in the sidebar and chat</p>
              </div>

              <div className="border-t border-edge" />

              {/* ─ Appearance ─ */}
              <div className="grid grid-cols-2 gap-x-6 gap-y-4">
                {/* Theme */}
                <div>
                  <label className="mb-1.5 block text-body text-ink-muted">Theme</label>
                  <div className="flex gap-2">
                    <button
                      onClick={() => onUpdate({ theme: 'dark' })}
                      className={`rounded-control px-4 py-1.5 text-body font-medium transition-colors ${
                        settings.theme !== 'light'
                          ? 'bg-primary-8 text-on-primary'
                          : 'border border-edge bg-surface-raised text-ink hover:bg-edge'
                      }`}
                    >
                      Dark
                    </button>
                    <button
                      onClick={() => onUpdate({ theme: 'light' })}
                      className={`rounded-control px-4 py-1.5 text-body font-medium transition-colors ${
                        settings.theme === 'light'
                          ? 'bg-primary-8 text-on-primary'
                          : 'border border-edge bg-surface-raised text-ink hover:bg-edge'
                      }`}
                    >
                      Light
                    </button>
                  </div>
                </div>

                {/* Archived Session Retention */}
                <div>
                  <label className="mb-1.5 block text-body text-ink-muted">
                    <span className="flex items-center gap-1.5">
                      <IconArchive size={14} className="text-ink-muted" />
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
                      className="w-20 rounded-control border border-edge bg-surface px-3 py-2 text-body text-ink outline-none focus:border-primary-7"
                    />
                    <span className="text-body text-ink-muted">days</span>
                  </div>
                  <p className="mt-1 text-body text-ink-muted">Auto-delete archived sessions older than this. Applies to every repo.</p>
                </div>
              </div>

              <div className="border-t border-edge" />

              {/* ─ Sessions ─ */}
              <div>
                <label className="flex items-center gap-2.5 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={queueMessages}
                    onChange={e => {
                      const next = e.target.checked
                      setQueueMessages(next)
                      setQueueMessagesApi(settings.token, next).catch(() => setSaveError('Failed to save queue messages setting'))
                    }}
                    className="h-4 w-4 rounded border-edge-strong bg-surface-raised text-primary-7 accent-primary-7 cursor-pointer"
                  />
                  <span className="text-body text-ink-muted group-hover:text-ink transition-colors">
                    Queue messages across sessions
                  </span>
                </label>
                <p className="mt-1 ml-[26px] text-body text-ink-muted">
                  When enabled, messages sent while another session for the same repo is processing will be queued and sent automatically when it finishes.
                </p>
              </div>

              <div className="border-t border-edge" />

              {/* ─ Repository ─ */}
              <div className="space-y-4">
                <FolderPicker
                  value={reposPath}
                  token={settings.token}
                  placeholder="~/repos (default)"
                  helpText="Absolute path to your locally cloned repositories. Leave empty to use the server default."
                  inputClass="text-body"
                  onSave={async (p) => {
                    await setReposPathApi(settings.token, p)
                    setReposPath(p)
                  }}
                />

                <div>
                  <label className="flex items-center gap-2.5 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={autoWorktree}
                      onChange={e => onAutoWorktreeChange?.(e.target.checked)}
                      className="h-4 w-4 rounded border-edge-strong bg-surface-raised text-primary-7 accent-primary-7 cursor-pointer"
                    />
                    <span className="flex items-center gap-1.5 text-body text-ink-muted group-hover:text-ink transition-colors">
                      <IconGitBranch size={14} className="text-ink-muted" />
                      Auto-enable worktrees for new sessions
                    </span>
                  </label>
                  <p className="mt-1 ml-[26px] text-body text-ink-muted">When enabled, new sessions will automatically start in a git worktree</p>
                </div>

                <div>
                  <label className="mb-1.5 block text-body text-ink-muted">Worktree Branch Prefix</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={worktreePrefix}
                      onChange={e => {
                        const val = e.target.value
                        setWorktreePrefix(val)
                        setWorktreePrefixApi(settings.token, val).catch(() => setSaveError('Failed to save worktree prefix'))
                      }}
                      placeholder="wt/"
                      className="w-40 rounded-control border border-edge bg-surface px-3 py-2 text-body text-ink outline-none focus:border-primary-7"
                    />
                  </div>
                  <p className="mt-1 text-body text-ink-muted">Prefix for worktree branch names (e.g. wt/ → wt/abc12345)</p>
                </div>
              </div>

            </div>
          </SectionCard>

          {/* ── Permissions ── */}
          <SectionCard icon={<IconShieldLock size={15} />} title="Permissions">
            <div className="space-y-5">

              {/* ─ Default permission mode ─ */}
              <div>
                <label className="mb-1.5 block text-body text-ink-muted">Default permission mode for new sessions</label>
                <div className="flex flex-wrap gap-2">
                  {PERMISSION_MODES.map(mode => {
                    const selected = mode.id === defaultPermissionMode
                    const selectedClass = mode.dangerous
                      ? 'bg-error-8 text-ink-inverse'
                      : 'bg-primary-8 text-on-primary'
                    return (
                      <button
                        key={mode.id}
                        type="button"
                        onClick={() => { handleDefaultPermissionModeSelect(mode.id) }}
                        title={mode.description}
                        className={`rounded-control px-3 py-1.5 text-body font-medium transition-colors ${
                          selected ? selectedClass : 'border border-edge bg-surface-raised text-ink hover:bg-edge'
                        }`}
                      >
                        {mode.label}
                      </button>
                    )
                  })}
                </div>
                <p className="mt-1 text-body text-ink-muted">
                  {activePermissionMode?.description ?? 'Mode every new session starts in.'} Existing sessions keep their own mode.
                </p>
              </div>

              {/* ─ Dangerous default warning ─ */}
              {dangerousDefault && (
                <div className="flex items-start gap-2 rounded-control border border-warning-9/50 bg-warning-9/10 px-3 py-2">
                  <IconAlertTriangle size={14} className="text-warning-5 mt-0.5 shrink-0" />
                  <p className="text-body text-warning-5">
                    Every new session starts with &ldquo;{activePermissionMode.label}&rdquo; and will run tool calls
                    &mdash; file writes, bash commands, web requests &mdash; without asking.
                    Codekin stores permission mode app-wide, not per repo, so this is the only place it can be checked;
                    a repo cannot opt out on its own.
                  </p>
                </div>
              )}

              <div className="border-t border-edge" />

              {/* ─ Approved patterns across repos ─ */}
              <div>
                <label className="mb-1.5 block text-body text-ink-muted">Auto-approved patterns</label>
                {repoDirs.length === 0 ? (
                  <p className="text-body text-ink-muted">No repos loaded.</p>
                ) : approvalsLoading ? (
                  <p className="text-body text-ink-muted">Loading approvals...</p>
                ) : approvalsError ? (
                  <p className="text-body text-ink-muted">Could not load approvals.</p>
                ) : (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-body text-ink">
                      {approvalSummary?.total ?? 0} approved pattern{(approvalSummary?.total ?? 0) !== 1 ? 's' : ''}
                      {' '}across {approvalSummary?.repoCount ?? 0} repo{(approvalSummary?.repoCount ?? 0) !== 1 ? 's' : ''}
                    </span>
                    <button
                      type="button"
                      onClick={() => { void handleRevokeAllApprovals() }}
                      disabled={revoking || (approvalSummary?.total ?? 0) === 0}
                      className="rounded-control border border-edge bg-surface-raised px-3 py-1.5 text-body font-medium text-ink hover:bg-edge hover:text-error-5 disabled:opacity-50 transition-colors"
                    >
                      {revoking ? 'Revoking...' : 'Revoke all'}
                    </button>
                  </div>
                )}
                <p className="mt-1 text-body text-ink-muted">
                  Tools, bash commands and patterns Claude may run without asking. Scanned across {repoDirs.length} repo{repoDirs.length !== 1 ? 's' : ''}.
                </p>
              </div>

            </div>
          </SectionCard>

          {/* ── GitHub Webhooks ── */}
          <SectionCard icon={<IconBrandGithub size={15} />} title="GitHub Webhooks">
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
                    if (!healthRepo.trim() || !settings.token) return
                    setHealthLoading(true)
                    setHealthError(null)
                    setHealthResult(null)
                    try {
                      const result = await getIntegrationHealth(settings.token, healthRepo.trim(), webhookUrl)
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
                          const { preview } = await previewWebhookSetup(settings.token, healthRepo.trim(), webhookUrl)
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
                          const result = await testWebhookDelivery(settings.token, healthRepo.trim(), webhookUrl)
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
                              await applyWebhookSetup(settings.token, healthRepo.trim(), webhookUrl)
                              setWizardStep('done')
                              // Re-run health check
                              const result = await getIntegrationHealth(settings.token, healthRepo.trim(), webhookUrl)
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
          </SectionCard>
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 px-6 py-4 border-t border-edge flex items-center justify-between">
          <div>
            {saveError && (
              <p className="text-body text-error-5">{saveError}</p>
            )}
          </div>
          <div className="flex gap-2">
            {settings.token && (
              <button
                onClick={onClose}
                className="rounded-control px-4 py-2 text-body text-ink-muted hover:text-ink"
              >
                Cancel
              </button>
            )}
            <button
              onClick={handleSave}
              disabled={!tokenInput.trim()}
              className="rounded-control bg-primary-8 px-4 py-2 text-body font-medium text-on-primary hover:bg-primary-7 disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
