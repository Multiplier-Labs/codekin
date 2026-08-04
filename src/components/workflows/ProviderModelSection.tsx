/**
 * Combined provider selector + model picker for workflow modals.
 *
 * Fetches OpenCode and Codex models on mount to determine availability.
 * Shows provider toggle only when an alternative provider is available.
 * Delegates model rendering to WorkflowModelPicker.
 */

import { useState, useEffect } from 'react'
import { fetchClaudeModels, fetchOpenCodeModels, fetchCodexModels } from '../../lib/ccApi'
import { MODEL_OPTIONS } from '../../lib/workflowHelpers'
import type { ModelOption, CodingProvider } from '../../types'
import { WorkflowModelPicker } from './WorkflowModelPicker'

const providerBtnClass = (selected: boolean) =>
  `rounded-control border px-3 py-1.5 text-body font-medium transition-colors ${
    selected
      ? 'border-accent-6 bg-accent-9/40 text-accent-2'
      : 'border-edge bg-surface text-neutral-3 hover:border-neutral-6 hover:text-neutral-2'
  }`

/** Fallback Claude model options for workflows (includes "Default" option). */
const FALLBACK_WORKFLOW_MODELS: ModelOption[] = MODEL_OPTIONS.map(m => ({
  id: m.value,
  label: m.label,
}))

interface Props {
  token: string
  /** Working directory (repo path) for scoping OpenCode model queries. */
  workingDir?: string
  provider: CodingProvider
  model: string
  onProviderChange: (provider: CodingProvider) => void
  onModelChange: (model: string) => void
}

export function ProviderModelSection({ token, workingDir, provider, model, onProviderChange, onModelChange }: Props) {
  const [openCodeAvailable, setOpenCodeAvailable] = useState<boolean | null>(null)
  const [openCodeModels, setOpenCodeModels] = useState<ModelOption[]>([])
  const [codexAvailable, setCodexAvailable] = useState<boolean | null>(null)
  const [codexModels, setCodexModels] = useState<ModelOption[]>([])
  const [claudeWorkflowModels, setClaudeWorkflowModels] = useState(FALLBACK_WORKFLOW_MODELS)
  const [loadingOcModels, setLoadingOcModels] = useState(true)
  const [loadingCodexModels, setLoadingCodexModels] = useState(true)

  // Fetch Claude models dynamically on mount
  useEffect(() => {
    let cancelled = false
    fetchClaudeModels(token).then(models => {
      if (cancelled || models.length === 0) return
      // Prepend the "Default (Opus)" option for workflows
      setClaudeWorkflowModels([
        { id: '', label: 'Default (Opus)' },
        ...models.map(m => ({ id: m.id, label: m.label })),
      ])
    }).catch(() => { /* keep fallback */ })
    return () => { cancelled = true }
  }, [token])

  // Check OpenCode availability on mount
  useEffect(() => {
    let cancelled = false
    fetchOpenCodeModels(token, workingDir).then(result => {
      if (cancelled) return
      if (result.models.length > 0) {
        setOpenCodeAvailable(true)
        setOpenCodeModels(result.models.map(m => ({ id: m.id, label: m.name || m.id })))
      } else {
        setOpenCodeAvailable(false)
      }
    }).catch(() => {
      if (!cancelled) setOpenCodeAvailable(false)
    }).finally(() => {
      if (!cancelled) setLoadingOcModels(false)
    })
    return () => { cancelled = true }
  }, [token, workingDir])

  // Check Codex availability on mount
  useEffect(() => {
    let cancelled = false
    fetchCodexModels(token).then(result => {
      if (cancelled) return
      if (result.models.length > 0) {
        setCodexAvailable(true)
        setCodexModels(result.models.map(m => ({ id: m.id, label: m.name || m.id })))
      } else {
        setCodexAvailable(false)
      }
    }).catch(() => {
      if (!cancelled) setCodexAvailable(false)
    }).finally(() => {
      if (!cancelled) setLoadingCodexModels(false)
    })
    return () => { cancelled = true }
  }, [token])

  // When switching provider, select a sensible default for the new provider
  const handleProviderChange = (newProvider: CodingProvider) => {
    if (newProvider === provider) return
    onProviderChange(newProvider)
    // Pick the first model from the new provider's list ('' = Default Opus for Claude)
    const newModels = newProvider === 'opencode' ? openCodeModels
      : newProvider === 'codex' ? codexModels
      : claudeWorkflowModels
    onModelChange(newModels[0]?.id ?? '')
  }

  const currentModels: ModelOption[] = provider === 'opencode' ? openCodeModels
    : provider === 'codex' ? codexModels
    : claudeWorkflowModels
  const isLoadingModels = (provider === 'opencode' && loadingOcModels) || (provider === 'codex' && loadingCodexModels)

  return (
    <div className="flex flex-wrap items-end gap-4">
      {/* Provider selector — only show when an alternative provider is available */}
      {(openCodeAvailable || codexAvailable) && (
        <div>
          <label className="block text-body font-medium text-neutral-3 mb-1">Provider</label>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => handleProviderChange('claude')}
              className={providerBtnClass(provider === 'claude')}
            >
              Claude Code
            </button>
            {openCodeAvailable && (
              <button
                type="button"
                onClick={() => handleProviderChange('opencode')}
                className={providerBtnClass(provider === 'opencode')}
              >
                OpenCode
              </button>
            )}
            {codexAvailable && (
              <button
                type="button"
                onClick={() => handleProviderChange('codex')}
                className={providerBtnClass(provider === 'codex')}
              >
                Codex
              </button>
            )}
          </div>
        </div>
      )}

      {/* Model picker */}
      <div>
        <label className="block text-body font-medium text-neutral-3 mb-1">Model</label>
        <WorkflowModelPicker
          models={currentModels}
          selected={model}
          onSelect={onModelChange}
          loading={isLoadingModels}
        />
      </div>
    </div>
  )
}
