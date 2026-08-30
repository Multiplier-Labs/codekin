/**
 * DeploymentsView — the Fleet tab of Automations.
 *
 * Registry of monitored deployed apps (and the host) with each probe's latest
 * sample, pm2 discovery proposals (never auto-enrolled — one click to
 * confirm), and a structured editor for probes. Samples refresh server-side
 * every 5 minutes; the hook polls slowly.
 */

import { useState } from 'react'
import {
  IconPlus, IconX, IconTrash, IconPencil, IconServer,
  IconPlayerPause, IconPlayerPlay, IconStethoscope,
} from '@tabler/icons-react'
import { useDeployments } from '../hooks/useDeployments'
import { formatTime } from '../lib/workflowHelpers'
import type { Deployment, ProbeConfig, DeploymentSample } from '../lib/deploymentsApi'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function probeLabel(probe: ProbeConfig): string {
  switch (probe.type) {
    case 'http': return probe.url
    case 'pm2': return `pm2: ${probe.processName}`
    case 'disk': return `disk: ${probe.path}`
    case 'log': return `log: ${probe.path}`
    case 'host': return 'host: memory · load · updates · reboot'
  }
}

/** The sample matching a probe, by the server's probeKey convention. */
function sampleFor(deployment: Deployment, probe: ProbeConfig): DeploymentSample | undefined {
  const target = probe.type === 'http' ? probe.url
    : probe.type === 'pm2' ? probe.processName
    : probe.type === 'disk' || probe.type === 'log' ? probe.path
    : 'system'
  return deployment.latestSamples.find(s => s.probeKey === `${deployment.id}::${probe.type}:${target}`)
}

function metricsSummary(sample: DeploymentSample): string {
  const m = sample.metrics
  switch (sample.probeType) {
    case 'http': {
      const parts = []
      if (m.status != null) parts.push(`HTTP ${m.status}`)
      if (m.latencyMs != null) parts.push(`${m.latencyMs}ms`)
      if (m.certDays != null) parts.push(`cert ${m.certDays}d`)
      return parts.join(' · ')
    }
    case 'pm2': {
      const parts = []
      if (m.status != null) parts.push(String(m.status))
      if (m.memoryMb != null) parts.push(`${m.memoryMb}MB`)
      if (m.restarts != null) parts.push(`${m.restarts} restarts`)
      return parts.join(' · ')
    }
    case 'disk':
      return m.freePct != null ? `${m.freePct}% free` : ''
    case 'log':
      return m.errorCount != null ? `${m.errorCount} error line(s)/window` : 'baselining'
    case 'host': {
      const parts = []
      if (m.memAvailablePct != null) parts.push(`mem ${m.memAvailablePct}%`)
      if (m.load1 != null) parts.push(`load ${m.load1}`)
      if (m.upgradable != null) parts.push(`${m.upgradable} updates (${m.securityUpgradable ?? 0} sec)`)
      if (m.rebootRequired) parts.push('reboot required')
      return parts.join(' · ')
    }
  }
}

// ---------------------------------------------------------------------------
// Probe status row
// ---------------------------------------------------------------------------

function ProbeRow({ deployment, probe }: { deployment: Deployment; probe: ProbeConfig }) {
  const sample = sampleFor(deployment, probe)
  const dot = !sample ? 'bg-edge-strong'
    : sample.ok ? 'bg-success-5'
    : 'bg-error-5'

  return (
    <div className="flex items-center gap-3 px-3 py-1.5">
      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${dot}`} title={sample ? (sample.ok ? 'healthy' : 'breached') : 'no sample yet'} />
      <span className="min-w-0 truncate text-body text-ink">{probeLabel(probe)}</span>
      {sample && (
        <span className="whitespace-nowrap text-meta text-ink-muted">{metricsSummary(sample)}</span>
      )}
      {sample && !sample.ok && (
        <span className="min-w-0 truncate text-meta text-error-4" title={sample.breaches.join('; ')}>
          {sample.breaches.join('; ')}
        </span>
      )}
      <span className="ml-auto whitespace-nowrap text-meta tabular-nums text-ink-faint">
        {sample ? formatTime(sample.createdAt) : 'pending'}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Editor modal
// ---------------------------------------------------------------------------

const EMPTY_DRAFT: Omit<Deployment, 'latestSamples'> = {
  id: '', name: '', repoPath: '', enabled: true, autoDiagnose: false, probes: [],
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-meta text-ink-muted">{label}</span>
      {children}
    </label>
  )
}

const inputClass = 'w-full rounded-control border border-edge bg-surface px-2.5 py-1.5 text-body text-ink focus:border-focus focus:outline-none'

function DeploymentEditor({ initial, onSave, onClose }: {
  initial: Omit<Deployment, 'latestSamples'> | null
  onSave: (d: Omit<Deployment, 'latestSamples'>) => Promise<void>
  onClose: () => void
}) {
  const editing = initial !== null
  const [draft, setDraft] = useState(initial ?? EMPTY_DRAFT)
  const [probeType, setProbeType] = useState<ProbeConfig['type']>('http')
  const [probeTarget, setProbeTarget] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const addProbe = () => {
    let probe: ProbeConfig | null = null
    if (probeType === 'http' && /^https?:\/\//.test(probeTarget)) {
      probe = { type: 'http', url: probeTarget, checkTls: probeTarget.startsWith('https:') }
    } else if (probeType === 'pm2' && probeTarget) {
      probe = { type: 'pm2', processName: probeTarget }
    } else if (probeType === 'disk' && probeTarget.startsWith('/')) {
      probe = { type: 'disk', path: probeTarget }
    } else if (probeType === 'log' && probeTarget.startsWith('/')) {
      probe = { type: 'log', path: probeTarget }
    } else if (probeType === 'host') {
      probe = { type: 'host' }
    }
    if (!probe) {
      setError(probeType === 'http' ? 'http probe needs an http(s) URL'
        : probeType === 'pm2' ? 'pm2 probe needs a process name'
        : `${probeType} probe needs an absolute path`)
      return
    }
    setError(null)
    setDraft(d => ({ ...d, probes: [...d.probes, probe] }))
    setProbeTarget('')
  }

  const save = async () => {
    if (!draft.name || draft.probes.length === 0) {
      setError('A name and at least one probe are required')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const id = draft.id || draft.name.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-')
      await onSave({ ...draft, id, repoPath: draft.repoPath || undefined })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-floating border border-edge-strong bg-surface-raised p-5 shadow-floating" onClick={(e) => { e.stopPropagation() }}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-title font-medium text-ink">{editing ? 'Edit deployment' : 'Add deployment'}</h2>
          <button onClick={onClose} className="rounded-control p-1 text-ink-muted hover:bg-edge hover:text-ink">
            <IconX size={18} stroke={2} />
          </button>
        </div>

        <div className="space-y-3">
          <Field label="Name">
            <input value={draft.name} onChange={(e) => { setDraft(d => ({ ...d, name: e.target.value })) }} placeholder="Codekin production" className={inputClass} />
          </Field>
          <Field label="Linked repo path (optional — enables incident diagnosis)">
            <input value={draft.repoPath ?? ''} onChange={(e) => { setDraft(d => ({ ...d, repoPath: e.target.value })) }} placeholder="/srv/repos/my-app" className={inputClass} />
          </Field>

          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-body text-ink">
              <input type="checkbox" checked={draft.enabled} onChange={(e) => { setDraft(d => ({ ...d, enabled: e.target.checked })) }} />
              Enabled
            </label>
            <label className="flex items-center gap-2 text-body text-ink" title="Spawn a diagnostic child session automatically on probe breach (requires a linked repo). The child investigates and reports — it never operates the system.">
              <input type="checkbox" checked={draft.autoDiagnose ?? false} onChange={(e) => { setDraft(d => ({ ...d, autoDiagnose: e.target.checked })) }} />
              Auto-diagnose breaches
            </label>
          </div>

          <div>
            <span className="mb-1 block text-meta text-ink-muted">Probes</span>
            {draft.probes.length === 0 && <div className="mb-1 text-meta text-ink-faint">No probes yet — add at least one.</div>}
            {draft.probes.map((probe, i) => (
              <div key={i} className="mb-1 flex items-center gap-2 rounded-control border border-edge bg-surface px-2.5 py-1.5">
                <span className="min-w-0 flex-1 truncate text-body text-ink">{probeLabel(probe)}</span>
                <button
                  onClick={() => { setDraft(d => ({ ...d, probes: d.probes.filter((_, j) => j !== i) })) }}
                  className="rounded-control p-1 text-ink-faint hover:bg-edge hover:text-error-4"
                  title="Remove probe"
                >
                  <IconTrash size={14} stroke={2} />
                </button>
              </div>
            ))}
            <div className="mt-1.5 flex items-center gap-2">
              <select value={probeType} onChange={(e) => { setProbeType(e.target.value as ProbeConfig['type']) }} className="rounded-control border border-edge bg-surface px-2 py-1.5 text-body text-ink focus:border-focus focus:outline-none">
                <option value="http">http</option>
                <option value="pm2">pm2</option>
                <option value="disk">disk</option>
                <option value="log">log</option>
                <option value="host">host</option>
              </select>
              {probeType !== 'host' && (
                <input
                  value={probeTarget}
                  onChange={(e) => { setProbeTarget(e.target.value) }}
                  placeholder={probeType === 'http' ? 'https://…/health' : probeType === 'pm2' ? 'process name' : probeType === 'log' ? '/var/log/app.log' : '/mount/path'}
                  className={inputClass}
                  onKeyDown={(e) => { if (e.key === 'Enter') addProbe() }}
                />
              )}
              <button onClick={addProbe} className="flex shrink-0 items-center gap-1 rounded-control border border-edge px-2.5 py-1.5 text-body text-ink hover:bg-edge">
                <IconPlus size={14} stroke={2} /> Add
              </button>
            </div>
          </div>

          {error && <div className="text-meta text-error-4">{error}</div>}

          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onClose} className="rounded-control px-3 py-1.5 text-body text-ink-muted hover:bg-edge hover:text-ink">Cancel</button>
            <button onClick={() => { void save() }} disabled={saving} className="rounded-control bg-primary-7 px-3 py-1.5 text-body text-ink-inverse hover:bg-primary-6 disabled:opacity-50">
              {saving ? 'Saving…' : editing ? 'Save changes' : 'Add deployment'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export function DeploymentsView({ token }: { token: string }) {
  const { deployments, discovered, loading, error, save, update, remove } = useDeployments(token)
  const [editing, setEditing] = useState<Omit<Deployment, 'latestSamples'> | null | 'new'>(null)

  const proposals = discovered.filter(p => !p.alreadyConfigured)
  const hostConfigured = deployments.some(d => d.probes.some(p => p.type === 'host'))

  const adoptPm2 = (name: string) => {
    void save({ id: name, name, enabled: true, probes: [{ type: 'pm2', processName: name }] })
  }

  const addHostMonitoring = () => {
    void save({
      id: 'host', name: 'This machine', enabled: true,
      probes: [{ type: 'host' }, { type: 'disk', path: '/' }],
    })
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4">
      <div className="flex items-center gap-2">
        <span className="text-body font-semibold text-ink">Monitored deployments</span>
        <span className="text-meta text-ink-faint">{deployments.length}</span>
        <button
          onClick={() => { setEditing('new') }}
          className="ml-auto flex items-center gap-1 rounded-control border border-edge px-2.5 py-1.5 text-body text-ink hover:bg-edge"
        >
          <IconPlus size={14} stroke={2} /> Add deployment
        </button>
      </div>

      {error && <div className="rounded-control border border-error-7 bg-error-10/40 px-3 py-2 text-body text-error-3">{error}</div>}

      {/* Discovery proposals — confirm-to-monitor, never auto-enrolled */}
      {(proposals.length > 0 || !hostConfigured) && (
        <div className="rounded-control border border-edge bg-surface px-3 py-2.5">
          <div className="mb-1.5 text-meta text-ink-muted">Suggestions</div>
          <div className="flex flex-wrap items-center gap-2">
            {proposals.map(p => (
              <button
                key={p.name}
                onClick={() => { adoptPm2(p.name) }}
                className="flex items-center gap-1.5 rounded-control border border-edge px-2.5 py-1 text-body text-ink hover:bg-edge"
                title={`pm2 process (${p.status}) — click to monitor`}
              >
                <IconServer size={14} stroke={2} className="text-ink-muted" /> {p.name}
                <IconPlus size={12} stroke={2} className="text-ink-faint" />
              </button>
            ))}
            {!hostConfigured && (
              <button
                onClick={addHostMonitoring}
                className="flex items-center gap-1.5 rounded-control border border-edge px-2.5 py-1 text-body text-ink hover:bg-edge"
                title="Memory, load, pending updates, reboot state, root disk"
              >
                <IconStethoscope size={14} stroke={2} className="text-ink-muted" /> Monitor this machine
                <IconPlus size={12} stroke={2} className="text-ink-faint" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Deployment cards */}
      {loading && deployments.length === 0 && <div className="text-body text-ink-muted">Loading…</div>}
      {!loading && deployments.length === 0 && (
        <div className="rounded-control border border-edge bg-surface px-4 py-6 text-center text-body text-ink-muted">
          Nothing monitored yet. Add a deployment, or accept a suggestion above — probes run every 5 minutes, breaches alert the agent.
        </div>
      )}
      {deployments.map(deployment => (
        <div key={deployment.id} className={`overflow-hidden rounded-control border border-edge bg-surface ${deployment.enabled ? '' : 'opacity-60'}`}>
          <div className="group flex items-center gap-2 border-b border-edge bg-surface-raised/20 px-3 py-2">
            <span className="text-body font-semibold text-ink">{deployment.name}</span>
            {!deployment.enabled && <span className="text-meta text-warning-5">paused</span>}
            {deployment.autoDiagnose && (
              <span className="text-meta text-secondary-4" title="Probe breaches spawn a diagnostic child session automatically">auto-diagnose</span>
            )}
            {deployment.repoPath && (
              <span className="min-w-0 truncate text-meta text-ink-faint" title={deployment.repoPath}>
                {deployment.repoPath.split('/').pop()}
              </span>
            )}
            <div className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
              <button
                onClick={() => { void update(deployment.id, { enabled: !deployment.enabled }) }}
                className="rounded-control p-1 text-ink-muted hover:bg-edge hover:text-ink"
                title={deployment.enabled ? 'Pause monitoring' : 'Resume monitoring'}
              >
                {deployment.enabled ? <IconPlayerPause size={14} stroke={2} /> : <IconPlayerPlay size={14} stroke={2} />}
              </button>
              <button
                onClick={() => {
                  setEditing({
                    id: deployment.id, name: deployment.name, repoPath: deployment.repoPath,
                    enabled: deployment.enabled, autoDiagnose: deployment.autoDiagnose, probes: deployment.probes,
                  })
                }}
                className="rounded-control p-1 text-ink-muted hover:bg-edge hover:text-ink"
                title="Edit"
              >
                <IconPencil size={14} stroke={2} />
              </button>
              <button
                onClick={() => { if (confirm(`Stop monitoring "${deployment.name}"?`)) void remove(deployment.id) }}
                className="rounded-control p-1 text-ink-faint hover:bg-edge hover:text-error-4"
                title="Delete"
              >
                <IconTrash size={14} stroke={2} />
              </button>
            </div>
          </div>
          <div className="py-1">
            {deployment.probes.map((probe, i) => (
              <ProbeRow key={i} deployment={deployment} probe={probe} />
            ))}
          </div>
        </div>
      ))}

      {editing !== null && (
        <DeploymentEditor
          initial={editing === 'new' ? null : editing}
          onSave={save}
          onClose={() => { setEditing(null) }}
        />
      )}
    </div>
  )
}
