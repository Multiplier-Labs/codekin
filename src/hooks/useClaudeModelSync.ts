/**
 * Fetches available Claude models dynamically from the Anthropic API
 * via the server's /api/claude/models endpoint.
 *
 * Starts with the hardcoded CLAUDE_MODELS as initial state (no empty flash),
 * then replaces with API results once fetched. Falls back silently on error.
 */

import { useState, useEffect, useRef } from 'react'
import { fetchClaudeModels } from '../lib/ccApi'
import { CLAUDE_MODELS } from '../types'
import type { ModelOption } from '../types'

export function useClaudeModelSync({
  token,
  currentModel,
  setModel,
}: {
  token: string
  currentModel: string | null
  setModel: (model: string) => void
}): { claudeModels: ModelOption[] } {
  const [claudeModels, setClaudeModels] = useState<ModelOption[]>(CLAUDE_MODELS)
  const hasFetched = useRef(false)
  const currentModelRef = useRef(currentModel)
  useEffect(() => { currentModelRef.current = currentModel }, [currentModel])

  useEffect(() => {
    if (!token || hasFetched.current) return
    hasFetched.current = true

    fetchClaudeModels(token)
      .then(models => {
        if (models.length === 0) return // keep fallback
        const mapped: ModelOption[] = models.map(m => ({ id: m.id, label: m.label }))
        setClaudeModels(mapped)

        // If the current model isn't in the fetched list, auto-select the first
        if (currentModelRef.current && !mapped.some(m => m.id === currentModelRef.current)) {
          setModel(mapped[0].id)
        }
      })
      .catch(() => {
        // keep CLAUDE_MODELS fallback
      })
  }, [token, setModel])

  return { claudeModels }
}
