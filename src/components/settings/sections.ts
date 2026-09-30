/**
 * The Settings section map (docs/SETTINGS-VIEW-SPEC.md): every page of the
 * Settings view, the group it belongs to, and when it is shown.
 */

import type { ComponentType } from 'react'
import {
  IconArchive, IconBrandGithub, IconId, IconKey, IconPalette, IconServer2, IconShieldCheck,
  IconShieldLock, IconUserCog, IconUserPlus, IconUsersGroup,
} from '@tabler/icons-react'

export type SettingsSectionId =
  | 'profile' | 'security' | 'appearance'
  | 'workspace' | 'members' | 'machines'
  | 'connection' | 'sessions' | 'permissions' | 'webhooks'
  | 'accounts'

export type SettingsGroup = 'Account' | 'Workspace' | 'This machine' | 'Platform'

export const SETTINGS_GROUPS: SettingsGroup[] = ['Account', 'Workspace', 'This machine', 'Platform']

export interface SectionDef {
  id: SettingsSectionId
  group: SettingsGroup
  label: string
  icon: ComponentType<{ size?: number; className?: string }>
  /** Only on app.codekin.ai (accounts, workspaces). */
  hostedOnly?: boolean
  /** Lives on the machine: needs one connected (and, locally, a token). */
  machine?: boolean
  /** Reads the machine's settings API, which needs an access token. */
  needsToken?: boolean
  /** Only the platform operator. */
  operatorOnly?: boolean
}

export const SETTINGS_SECTIONS: SectionDef[] = [
  { id: 'profile', group: 'Account', label: 'Profile', icon: IconId, hostedOnly: true },
  { id: 'security', group: 'Account', label: 'Security', icon: IconShieldCheck, hostedOnly: true },
  { id: 'appearance', group: 'Account', label: 'Appearance', icon: IconPalette },
  { id: 'workspace', group: 'Workspace', label: 'General', icon: IconUsersGroup, hostedOnly: true },
  { id: 'members', group: 'Workspace', label: 'Members', icon: IconUserPlus, hostedOnly: true },
  { id: 'machines', group: 'Workspace', label: 'Machines', icon: IconServer2, hostedOnly: true },
  { id: 'connection', group: 'This machine', label: 'Connection', icon: IconKey, machine: true },
  { id: 'sessions', group: 'This machine', label: 'Sessions', icon: IconArchive, machine: true, needsToken: true },
  { id: 'permissions', group: 'This machine', label: 'Permissions', icon: IconShieldLock, machine: true, needsToken: true },
  { id: 'webhooks', group: 'This machine', label: 'GitHub webhooks', icon: IconBrandGithub, machine: true, needsToken: true },
  { id: 'accounts', group: 'Platform', label: 'Accounts', icon: IconUserCog, hostedOnly: true, operatorOnly: true },
]

export interface SectionContext {
  hosted: boolean
  hasToken: boolean
  /** A machine is connected (always true in the local app). */
  connected?: boolean
  isOperator?: boolean
}

function applies(s: SectionDef, ctx: SectionContext): boolean {
  return (!s.hostedOnly || ctx.hosted) && (!s.operatorOnly || ctx.isOperator === true)
}

/** The sections that can be opened here. */
export function availableSections(ctx: SectionContext): SectionDef[] {
  const connected = ctx.connected ?? true
  return SETTINGS_SECTIONS.filter(s =>
    applies(s, ctx) && (!s.machine || connected) && (!s.needsToken || ctx.hasToken))
}

/**
 * Sections listed but not openable: machine settings while no machine is
 * connected, so the nav says where they went rather than hiding them.
 */
export function unavailableSections(ctx: SectionContext): SectionDef[] {
  if (ctx.connected ?? true) return []
  return SETTINGS_SECTIONS.filter(s => applies(s, ctx) && s.machine === true)
}

/** Where a URL section lands: itself when shown here, otherwise null. */
export function resolveSection(requested: string | null, available: SectionDef[]): SettingsSectionId | null {
  return available.find(s => s.id === requested)?.id ?? null
}
