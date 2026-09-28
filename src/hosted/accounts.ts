/**
 * The operator's view of every account on the platform (relay /api/users):
 * status — the kill switch across all workspaces — and who may create
 * workspaces. Changes need a fresh second-factor check (stepUpFetch).
 */

import { stepUpFetch } from './mfa'

export interface PlatformAccount {
  id: string
  githubId: number
  login: string
  displayName: string | null
  avatarUrl: string | null
  status: 'active' | 'pending' | 'disabled'
  canCreateWorkspaces: boolean
  isOperator: boolean
}

export async function fetchAccounts(): Promise<PlatformAccount[]> {
  const res = await fetch('/api/users', { credentials: 'include' })
  if (!res.ok) throw new Error('Could not load accounts')
  return ((await res.json()) as { users: PlatformAccount[] }).users
}

export async function updateAccount(
  id: string,
  change: { status?: PlatformAccount['status']; canCreateWorkspaces?: boolean },
): Promise<PlatformAccount> {
  const res = await stepUpFetch(`/api/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(change),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `Request failed (${res.status})`)
  }
  return ((await res.json()) as { user: PlatformAccount }).user
}

/** Signed-in identity and platform role, from /api/me. */
export interface Me {
  id: string
  login: string
  displayName: string | null
  avatarUrl: string | null
  isOperator: boolean
  workspaceNames: Record<string, string>
}

export async function fetchMe(): Promise<Me | null> {
  const res = await fetch('/api/me', { credentials: 'include' })
  if (!res.ok) return null
  const data = (await res.json()) as {
    user: { id: string; login: string; displayName: string | null; avatarUrl: string | null } | null
    isOperator?: boolean
    workspaces?: Array<{ id: string; name: string }>
  }
  if (!data.user) return null
  return {
    ...data.user,
    isOperator: data.isOperator ?? false,
    workspaceNames: Object.fromEntries((data.workspaces ?? []).map(w => [w.id, w.name])),
  }
}

/** End this browser's session and start over at the sign-in page. */
export async function signOut(): Promise<void> {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
  } finally {
    window.location.assign('/')
  }
}
