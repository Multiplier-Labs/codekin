/**
 * Approvals panel for the right sidebar.
 *
 * Displays per-repo auto-approved tools and bash commands with search,
 * collapsible groups, and revoke controls. Extracted from the Settings modal.
 */

import { useState, useEffect, useMemo } from 'react'
import { getRepoApprovals, removeRepoApproval, bulkRemoveRepoApprovals, type RepoApprovals } from '../lib/ccApi'

interface Props {
  token: string
  workingDir: string | null
  visible: boolean
}

export function ApprovalsPanel({ token, workingDir, visible }: Props) {
  const [approvals, setApprovals] = useState<RepoApprovals | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  // Fetch when panel becomes visible or workingDir/token changes
  useEffect(() => {
    if (!visible || !workingDir || !token) return
    let cancelled = false
    setLoading(true) // eslint-disable-line react-hooks/set-state-in-effect -- data fetching
    setError(false)  
    getRepoApprovals(token, workingDir)
      .then(data => { if (!cancelled) setApprovals(data) })
      .catch(() => { if (!cancelled) { setApprovals(null); setError(true) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [visible, workingDir, token])

  if (!visible) return null

  async function handleRemove(opts: { tool?: string; command?: string; pattern?: string }) {
    if (!workingDir || !token) return
    try {
      await removeRepoApproval(token, workingDir, opts)
      const updated = await getRepoApprovals(token, workingDir)
      setApprovals(updated)
    } catch {
      getRepoApprovals(token, workingDir)
        .then(setApprovals)
        .catch(() => {})
    }
  }

  async function handleRevokeMultiple(items: Array<{ tool?: string; command?: string; pattern?: string }>) {
    if (!workingDir || !token || items.length === 0) return
    try {
      await bulkRemoveRepoApprovals(token, workingDir, items)
      const updated = await getRepoApprovals(token, workingDir)
      setApprovals(updated)
    } catch {
      getRepoApprovals(token, workingDir)
        .then(setApprovals)
        .catch(() => {})
    }
  }

  if (!workingDir) {
    return (
      <div className="border-t border-neutral-8/30 px-3 py-3">
        <p className="text-[13px] text-neutral-5">Select a session to manage approvals.</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="border-t border-neutral-8/30 px-3 py-3">
        <p className="text-[13px] text-neutral-5">Loading...</p>
      </div>
    )
  }

  if (error || !approvals) {
    return (
      <div className="border-t border-neutral-8/30 px-3 py-3">
        <p className="text-[13px] text-neutral-5">Could not load approvals.</p>
      </div>
    )
  }

  const repoName = workingDir.split('/').pop() || workingDir

  return (
    <div className="border-t border-neutral-8/30 flex flex-col min-h-0">
      {/* Indented content to visually anchor under the repo */}
      <div className="ml-3 border-l border-neutral-7/30 flex flex-col min-h-0">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-1.5 flex-shrink-0">
          <span className="text-[13px] font-medium text-neutral-5 uppercase tracking-wider flex-shrink-0">Approvals</span>
          <span className="text-[12px] font-mono text-neutral-6 truncate" title={workingDir}>{repoName}</span>
        </div>
        <ApprovalsContent
          approvals={approvals}
          onRemove={handleRemove}
          onRevokeMultiple={handleRevokeMultiple}
        />
      </div>
    </div>
  )
}

/* ── Approvals Content ──────────────────────────────────────────── */

function ApprovalsContent({ approvals, onRemove, onRevokeMultiple }: {
  approvals: RepoApprovals
  onRemove: (opts: { tool?: string; command?: string; pattern?: string }) => void
  onRevokeMultiple: (items: Array<{ tool?: string; command?: string; pattern?: string }>) => void
}) {
  const [collapsedGroups, setCollapsedGroups] = useState(new Set(['__tools__', '__commands__', '__patterns__']))

  const totalCount = approvals.tools.length + approvals.commands.length + approvals.patterns.length
  const empty = totalCount === 0

  function toggleGroup(key: string) {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const filteredTools = useMemo(
    () => [...approvals.tools].sort(),
    [approvals.tools],
  )

  const filteredPatterns = useMemo(
    () => [...(approvals.patterns ?? [])].sort(),
    [approvals.patterns],
  )

  const commandGroups = useMemo(() => {
    return groupCommandsByPrefix(approvals.commands)
  }, [approvals.commands])

  const commandGroupEntries = Object.entries(commandGroups)
  const hasTools = filteredTools.length > 0
  const hasPatterns = filteredPatterns.length > 0
  const hasCommands = commandGroupEntries.length > 0

  return (
    <>
      {/* Header row */}
      {!empty && (
        <div className="flex-shrink-0 px-3 pb-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-neutral-5">
              {totalCount} rule{totalCount !== 1 ? 's' : ''}
            </span>
            <button
              onClick={() => {
                const items: Array<{ tool?: string; command?: string; pattern?: string }> = [
                  ...approvals.tools.map(t => ({ tool: t })),
                  ...approvals.commands.map(c => ({ command: c })),
                  ...(approvals.patterns ?? []).map(p => ({ pattern: p })),
                ]
                if (confirm(`Revoke all ${totalCount} approval rules?`)) {
                  onRevokeMultiple(items)
                }
              }}
              className="text-[13px] text-neutral-5 hover:text-error-5 transition-colors"
            >
              Revoke All
            </button>
          </div>
        </div>
      )}

      {/* Scrollable list */}
      <div className="overflow-y-auto min-h-0 flex-1 px-2 py-1 approvals-scroll">
        {!hasTools && !hasPatterns && !hasCommands && (
          <p className="text-[13px] text-neutral-6 py-2 text-center">
            No auto-approval rules yet.
          </p>
        )}

        <div className="space-y-2">
          {hasPatterns && (
            <ApprovalSection
              title="Patterns"
              count={filteredPatterns.length}
              collapsed={collapsedGroups.has('__patterns__')}
              onToggle={() => { toggleGroup('__patterns__'); }}
              onRevokeAll={() => {
                if (confirm(`Revoke all ${filteredPatterns.length} pattern approvals?`)) {
                  onRevokeMultiple(filteredPatterns.map(p => ({ pattern: p })))
                }
              }}
            >
              <ul className="space-y-0.5">
                {filteredPatterns.map(pattern => (
                  <li key={pattern} className="group flex items-center justify-between rounded-md px-2 py-1 text-[13px] text-neutral-3 hover:bg-neutral-6/50 hover:text-neutral-1 transition-colors">
                    <code className="truncate font-mono">{pattern}</code>
                    <button
                      onClick={() => { onRemove({ pattern }); }}
                      className="ml-2 flex-shrink-0 text-neutral-5 opacity-0 group-hover:opacity-100 hover:text-error-5 transition-all"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            </ApprovalSection>
          )}

          {hasTools && (
            <ApprovalSection
              title="Tools"
              count={filteredTools.length}
              collapsed={collapsedGroups.has('__tools__')}
              onToggle={() => { toggleGroup('__tools__'); }}
              onRevokeAll={() => {
                if (confirm(`Revoke all ${filteredTools.length} tool approvals?`)) {
                  onRevokeMultiple(filteredTools.map(t => ({ tool: t })))
                }
              }}
            >
              <ul className="space-y-0.5">
                {filteredTools.map(tool => (
                  <li key={tool} className="group flex items-center justify-between rounded-md px-2 py-1 text-[13px] text-neutral-3 hover:bg-neutral-6/50 hover:text-neutral-1 transition-colors">
                    <span className="truncate">{tool}</span>
                    <button
                      onClick={() => { onRemove({ tool }); }}
                      className="ml-2 flex-shrink-0 text-neutral-5 opacity-0 group-hover:opacity-100 hover:text-error-5 transition-all"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            </ApprovalSection>
          )}

          {hasCommands && (
            <ApprovalSection
              title="Commands"
              count={approvals.commands.length}
              collapsed={collapsedGroups.has('__commands__')}
              onToggle={() => { toggleGroup('__commands__'); }}
              onRevokeAll={() => {
                const all = approvals.commands
                if (confirm(`Revoke all ${all.length} command approvals?`)) {
                  onRevokeMultiple(all.map(c => ({ command: c })))
                }
              }}
            >
              <div className="space-y-1.5">
                {commandGroupEntries.map(([prefix, cmds]) => (
                  <CommandGroup
                    key={prefix}
                    prefix={prefix}
                    commands={cmds}
                    collapsed={collapsedGroups.has(`cmd:${prefix}`)}
                    onToggle={() => { toggleGroup(`cmd:${prefix}`); }}
                    onRemove={cmd => { onRemove({ command: cmd }); }}
                    onRevokeAll={() => {
                      if (confirm(`Revoke all ${cmds.length} "${prefix}" approvals?`)) {
                        onRevokeMultiple(cmds.map(c => ({ command: c })))
                      }
                    }}
                  />
                ))}
              </div>
            </ApprovalSection>
          )}
        </div>
      </div>
    </>
  )
}

/* ── Helpers ────────────────────────────────────────────────────── */

function groupCommandsByPrefix(commands: string[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {}
  for (const cmd of commands) {
    const prefix = cmd.split(/\s+/)[0] || 'other'
    if (!groups[prefix]) groups[prefix] = []
    groups[prefix].push(cmd)
  }
  const sorted: Record<string, string[]> = {}
  for (const key of Object.keys(groups).sort()) {
    sorted[key] = groups[key].sort()
  }
  return sorted
}

function ApprovalSection({ title, count, collapsed, onToggle, onRevokeAll, children }: {
  title: string
  count: number
  collapsed: boolean
  onToggle: () => void
  onRevokeAll: () => void
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <button
          onClick={onToggle}
          className="flex items-center gap-1.5 text-[15px] text-neutral-4 hover:text-neutral-2 transition-colors"
        >
          <svg
            className={`w-2.5 h-2.5 transition-transform flex-shrink-0 ${collapsed ? '' : 'rotate-90'}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2.5}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          <span className="font-medium">{title}</span>
          <span className="text-[13px] text-neutral-5">{count}</span>
        </button>
        {!collapsed && count > 1 && (
          <button
            onClick={onRevokeAll}
            className="text-[13px] text-neutral-5 hover:text-error-5 transition-colors"
          >
            revoke all
          </button>
        )}
      </div>
      {!collapsed && children}
    </div>
  )
}

function CommandGroup({ prefix, commands, collapsed, onToggle, onRemove, onRevokeAll }: {
  prefix: string
  commands: string[]
  collapsed: boolean
  onToggle: () => void
  onRemove: (cmd: string) => void
  onRevokeAll: () => void
}) {
  if (commands.length === 1) {
    return (
      <div className="group flex items-center justify-between rounded-md px-2 py-1 hover:bg-neutral-6/50 transition-colors">
        <code className="truncate font-mono text-[13px] text-neutral-3" title={commands[0]}>
          $ {commands[0]}
        </code>
        <button
          onClick={() => { onRemove(commands[0]); }}
          className="ml-2 flex-shrink-0 text-neutral-5 opacity-0 group-hover:opacity-100 hover:text-error-5 transition-all"
        >
          ×
        </button>
      </div>
    )
  }

  return (
    <div className="rounded-md overflow-hidden">
      <div className="flex items-center justify-between px-2 py-0.5">
        <button
          onClick={onToggle}
          className="flex items-center gap-1 text-[13px] text-neutral-4 hover:text-neutral-2 transition-colors"
        >
          <svg
            className={`w-2 h-2 transition-transform flex-shrink-0 ${collapsed ? '' : 'rotate-90'}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2.5}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          <code className="font-mono font-medium">{prefix}</code>
          <span className="text-[13px] text-neutral-5">{commands.length}</span>
        </button>
        {!collapsed && (
          <button
            onClick={onRevokeAll}
            className="text-[13px] text-neutral-5 hover:text-error-5 transition-colors"
          >
            revoke all
          </button>
        )}
      </div>
      {!collapsed && (
        <ul className="pl-3">
          {commands.map(cmd => (
            <li key={cmd} className="group flex items-center justify-between rounded-md px-2 py-1 hover:bg-neutral-6/50 transition-colors">
              <code className="truncate font-mono text-[13px] text-neutral-3" title={cmd}>
                $ {cmd}
              </code>
              <button
                onClick={() => { onRemove(cmd); }}
                className="ml-2 flex-shrink-0 text-neutral-5 opacity-0 group-hover:opacity-100 hover:text-error-5 transition-all"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
