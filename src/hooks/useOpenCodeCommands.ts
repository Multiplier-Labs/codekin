import { useState, useEffect } from 'react'
import { fetchOpenCodeCommands } from '../lib/ccApi'
import type { OpenCodeCommand } from '../lib/slashCommands'
import type { CodingProvider } from '../types'

interface UseOpenCodeCommandsOptions {
  token: string
  activeSessionProvider: CodingProvider
  activeOpenCodeWd: string | undefined
  openCodeDisabled: boolean
}

/**
 * Fetches the OpenCode command list (slash commands / skills / MCP prompts)
 * for the active OpenCode session's working directory, so the slash-command
 * autocomplete can offer them. Commands are routed server-side.
 */
export function useOpenCodeCommands({
  token,
  activeSessionProvider,
  activeOpenCodeWd,
  openCodeDisabled,
}: UseOpenCodeCommandsOptions): OpenCodeCommand[] {
  const [commands, setCommands] = useState<OpenCodeCommand[]>([])
  const [fetchedDir, setFetchedDir] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (activeSessionProvider !== 'opencode' || !token || openCodeDisabled) return
    if (commands.length > 0 && activeOpenCodeWd === fetchedDir) return
    let cancelled = false
    fetchOpenCodeCommands(token, activeOpenCodeWd).then(result => {
      if (cancelled) return
      setCommands(result)
      setFetchedDir(activeOpenCodeWd)
    }).catch(() => { /* commands menu simply stays empty */ })
    return () => { cancelled = true }
  }, [activeSessionProvider, token, openCodeDisabled, activeOpenCodeWd, fetchedDir, commands.length])

  return commands
}
