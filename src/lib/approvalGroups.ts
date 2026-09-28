/**
 * Approval rules grouped for display: one decision per tool, with every bash
 * command and wildcard pattern folded under its leading binary. Shared by the
 * repo drawer's Approvals tab and Settings → Permissions.
 */

import { IconShieldCheck, IconPencil, IconMap2, IconAlertTriangle } from '@tabler/icons-react'
import type { RepoApprovals } from './ccApi'

export const PERMISSION_MODE_ICONS: Record<string, typeof IconShieldCheck> = {
  shield: IconShieldCheck,
  pencil: IconPencil,
  map: IconMap2,
  warning: IconAlertTriangle,
}

/** What `removeRepoApproval` / `bulkRemoveRepoApprovals` accept. */
export type RemovalTarget = { tool?: string; command?: string; pattern?: string }

export interface ApprovalGroup {
  key: string
  label: string
  kind: 'tool' | 'bash'
  rules: { id: string; label: string; target: RemovalTarget }[]
}

/**
 * Collapse the three flat rule lists into one decision per tool: every bash
 * command and wildcard pattern folds into the group of its leading binary.
 */
export function buildGroups(approvals: RepoApprovals): ApprovalGroup[] {
  const tools: ApprovalGroup[] = [...approvals.tools].sort((a, b) => a.localeCompare(b)).map(tool => ({
    key: `tool:${tool}`,
    label: tool,
    kind: 'tool' as const,
    rules: [{ id: `tool:${tool}`, label: tool, target: { tool } }],
  }))

  const bash = new Map<string, ApprovalGroup>()
  function addBash(raw: string, target: RemovalTarget) {
    const prefix = raw.split(/\s+/)[0] || 'other'
    let group = bash.get(prefix)
    if (!group) {
      group = { key: `bash:${prefix}`, label: prefix, kind: 'bash', rules: [] }
      bash.set(prefix, group)
    }
    group.rules.push({ id: `${group.key}:${raw}`, label: raw, target })
  }
  for (const command of approvals.commands) addBash(command, { command })
  for (const pattern of approvals.patterns) addBash(pattern, { pattern })

  const bashGroups = [...bash.values()].sort((a, b) => a.label.localeCompare(b.label))
  for (const group of bashGroups) group.rules.sort((a, b) => a.label.localeCompare(b.label))

  return [...tools, ...bashGroups]
}

