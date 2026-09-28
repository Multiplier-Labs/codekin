/**
 * The Settings section map (docs/SETTINGS-VIEW-SPEC.md): every page of the
 * Settings view, the group it belongs to, and when it is shown.
 */

import type { ComponentType } from 'react'
import {
  IconArchive, IconBrandGithub, IconKey, IconPalette, IconServer2, IconShieldCheck,
  IconShieldLock, IconUserPlus, IconUsersGroup,
} from '@tabler/icons-react'

export type SettingsSectionId =
  | 'security' | 'appearance'
  | 'workspace' | 'members' | 'machines'
  | 'connection' | 'sessions' | 'permissions' | 'webhooks'

type SettingsGroup = 'Account' | 'Workspace' | 'This machine'

interface SectionDef {
  id: SettingsSectionId
  group: SettingsGroup
  label: string
  icon: ComponentType<{ size?: number; className?: string }>
  /** Only on app.codekin.ai (accounts, workspaces). */
  hostedOnly?: boolean
  /** Reads the machine's settings API, which needs an access token. */
  needsToken?: boolean
}

export const SETTINGS_SECTIONS: SectionDef[] = [
  { id: 'security', group: 'Account', label: 'Security', icon: IconShieldCheck, hostedOnly: true },
  { id: 'appearance', group: 'Account', label: 'Appearance', icon: IconPalette },
  { id: 'workspace', group: 'Workspace', label: 'General', icon: IconUsersGroup, hostedOnly: true },
  { id: 'members', group: 'Workspace', label: 'Members', icon: IconUserPlus, hostedOnly: true },
  { id: 'machines', group: 'Workspace', label: 'Machines', icon: IconServer2, hostedOnly: true },
  { id: 'connection', group: 'This machine', label: 'Connection', icon: IconKey },
  { id: 'sessions', group: 'This machine', label: 'Sessions', icon: IconArchive, needsToken: true },
  { id: 'permissions', group: 'This machine', label: 'Permissions', icon: IconShieldLock, needsToken: true },
  { id: 'webhooks', group: 'This machine', label: 'GitHub webhooks', icon: IconBrandGithub, needsToken: true },
]

/** The sections this app can show: hosted-only ones need hosted, machine ones a token. */
export function availableSections(opts: { hosted: boolean; hasToken: boolean }): SectionDef[] {
  return SETTINGS_SECTIONS.filter(s => (!s.hostedOnly || opts.hosted) && (!s.needsToken || opts.hasToken))
}

/** Where a URL section lands: itself when shown here, otherwise null. */
export function resolveSection(requested: string | null, available: SectionDef[]): SettingsSectionId | null {
  return available.find(s => s.id === requested)?.id ?? null
}
