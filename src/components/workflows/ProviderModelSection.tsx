/**
 * Combined provider selector + model picker for workflow modals.
 *
 * Fetches OpenCode models on mount to determine availability.
 * Shows provider toggle only when OpenCode is available.
 * Delegates model rendering to WorkflowModelPicker.
 */

import { useState, useEffect } from 'react'
import { fetchOpenCodeModels } from '../../lib/ccApi'
import { MODEL_OPTIONS } from '../../lib/workflowHelpers'
import type { ModelOption, CodingProvider } from '../../types'
import { WorkflowModelPicker } from './WorkflowModelPicker'

const providerBtnClass = (selected: boolean) =>
  `rounded-md border px-3 py-1.5 text-[13px] font-medium transition-colors ${
    selected
      ? 'border-accent-6 bg-accent-9/40 text-accent-2'
      : 'border-neutral-7 bg-neutral-10 text-neutral-3 hover:border-neutral-6 hover:text-neutral-2'
  }`

/** Claude model options for the workflow picker (includes "Default" option). */
const CLAUDE_WORKFLOW_MODELS: ModelOption[] = MODEL_OPTIONS.map(m => ({
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
  const [loadingOcModels, setLoadingOcModels] = useState(true)

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

  // When switching provider, reset model to default if current model doesn't belong to new provider
  const handleProviderChange = (newProvider: CodingProvider) => {
    if (newProvider === provider) return
    onProviderChange(newProvider)
    // Reset model — the current model likely doesn't exist in the other provider
    onModelChange('')
  }

  const currentModels: ModelOption[] = provider === 'opencode' ? openCodeModels : CLAUDE_WORKFLOW_MODELS
  const isLoadingModels = provider === 'opencode' && loadingOcModels

  return (
    <>
      {/* Provider selector — only show when OpenCode is available */}
      {openCodeAvailable && (
        <div>
          <label className="block text-[13px] font-medium text-neutral-3 mb-2">Provider</label>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => handleProviderChange('claude')}
              className={providerBtnClass(provider === 'claude')}
            >
              Claude Code
            </button>
            <button
              type="button"
              onClick={() => handleProviderChange('opencode')}
              className={providerBtnClass(provider === 'opencode')}
            >
              OpenCode
            </button>
          </div>
        </div>
      )}

      {/* Model picker */}
      <div>
        <label className="block text-[13px] font-medium text-neutral-3 mb-2">Model</label>
        <WorkflowModelPicker
          models={currentModels}
          selected={model}
          onSelect={onModelChange}
          loading={isLoadingModels}
        />
      </div>
    </>
  )
}
