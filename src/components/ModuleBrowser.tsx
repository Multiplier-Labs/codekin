/**
 * Sidebar panel for browsing and attaching context modules.
 *
 * Modules are reusable text blocks (instructions, prompts, context)
 * that can be injected into a chat message. Displays both global
 * modules and repo-specific modules when a repo is active.
 */

import type { Module, Repo } from '../types'

interface Props {
  repo: Repo | null
  globalModules?: Module[]
  onSendModule: (module: Module) => void
  disabled?: boolean
}

export function ModuleBrowser({ repo, globalModules = [], onSendModule, disabled }: Props) {
  const repoModules = repo?.modules ?? []
  if (globalModules.length === 0 && repoModules.length === 0) return null

  return (
    <div className="mt-3 border-t border-neutral-10 pt-3">
      <h3 className="mb-2 text-[15px] font-medium uppercase tracking-wider text-neutral-5">Modules</h3>

      {globalModules.length > 0 && (
        <>
          <div className="mb-1 px-2 text-[12px] font-medium uppercase tracking-wider text-neutral-5">Global</div>
          <div className="flex flex-col gap-1">
            {globalModules.map(mod => (
              <button
                key={mod.id}
                onClick={() => onSendModule(mod)}
                disabled={disabled}
                className="group rounded px-2 py-1.5 text-left transition hover:bg-neutral-10/50 disabled:opacity-50 disabled:pointer-events-none"
              >
                <div className="text-[15px] font-medium text-primary-6 group-hover:text-primary-5">
                  {mod.name}
                </div>
                {mod.description && (
                  <div className="text-[13px] text-neutral-4 group-hover:text-neutral-4">
                    {mod.description}
                  </div>
                )}
              </button>
            ))}
          </div>
        </>
      )}

      {repoModules.length > 0 && (
        <>
          <div className="mb-1 mt-2 px-2 text-[12px] font-medium uppercase tracking-wider text-neutral-5">{repo?.name}</div>
          <div className="flex flex-col gap-1">
            {repoModules.map(mod => (
              <button
                key={mod.id}
                onClick={() => onSendModule(mod)}
                disabled={disabled}
                className="group rounded px-2 py-1.5 text-left transition hover:bg-neutral-10/50 disabled:opacity-50 disabled:pointer-events-none"
              >
                <div className="text-[15px] font-medium text-primary-6 group-hover:text-primary-5">
                  {mod.name}
                </div>
                {mod.description && (
                  <div className="text-[13px] text-neutral-4 group-hover:text-neutral-4">
                    {mod.description}
                  </div>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
