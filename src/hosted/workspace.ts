/**
 * Workspaces on the hosted side: which one this tab is in, the header that
 * tells the relay, and the relay's workspace/member API.
 *
 * The current workspace is per tab (module state), so two tabs can sit in
 * different workspaces. localStorage only seeds it on load. Switching goes
 * through a full reload: every machine, share and socket belongs to one
 * workspace, and a fresh start is the simplest way to drop the old one's.
 */

import { forgetMachine } from './machines'

export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'viewer'

export interface Workspace {
  id: string
  name: string
  role: WorkspaceRole
  requireMfa: boolean
}

export interface WorkspaceMember {
  userId: string
  login: string
  displayName: string | null
  avatarUrl: string | null
  role: WorkspaceRole
  status: 'active' | 'suspended'
  accountStatus: 'active' | 'pending' | 'disabled'
  joinedAt: string
}

export interface WorkspaceMachine {
  id: string
  displayName: string
  hostname: string | null
  platform: string | null
  status: 'online' | 'offline' | 'degraded'
  lastSeenAt: string | null
  ownerUserId: string
  ownerLogin: string | null
  quarantined: boolean
}

/** The workspace that is never deletable (allowlist admission lands there). */
export const BOOTSTRAP_WORKSPACE_ID = 'org-default'

export const WORKSPACE_KEY = 'codekin.hosted.workspaceId'
export const WORKSPACE_HEADER = 'X-Codekin-Workspace'

let current: string | null = null

/**
 * Settle this tab's workspace from the account's list: the remembered one
 * while the account still belongs to it, otherwise the first (the relay
 * orders the default first). Null only for an account with no workspace.
 */
export function pickWorkspace(workspaces: Workspace[]): Workspace | null {
  const remembered = current ?? localStorage.getItem(WORKSPACE_KEY)
  const chosen = workspaces.find(w => w.id === remembered) ?? workspaces.at(0) ?? null
  current = chosen?.id ?? null
  if (chosen) localStorage.setItem(WORKSPACE_KEY, chosen.id)
  return chosen
}

export function currentWorkspaceId(): string | null {
  return current
}

/** For tests: forget the in-memory choice. */
export function resetWorkspaceForTests(): void {
  current = null
}

/** Headers that scope a relay call to this tab's workspace. */
export function workspaceHeaders(): Record<string, string> {
  return current ? { [WORKSPACE_HEADER]: current } : {}
}

/** Move this tab (and future loads) to another workspace. */
export function switchWorkspace(id: string): void {
  localStorage.setItem(WORKSPACE_KEY, id)
  // The remembered machine belongs to the workspace being left.
  forgetMachine()
  window.location.assign('/')
}

export type WorkspaceAction =
  | 'machine.pair'
  | 'machine.oversee'
  | 'member.manage'
  | 'member.manage_privileged'
  | 'workspace.edit'
  | 'workspace.delete'

const MATRIX: Record<WorkspaceAction, readonly WorkspaceRole[]> = {
  'machine.pair': ['owner', 'admin', 'member'],
  'machine.oversee': ['owner', 'admin'],
  'member.manage': ['owner', 'admin'],
  'member.manage_privileged': ['owner'],
  'workspace.edit': ['owner'],
  'workspace.delete': ['owner'],
}

/**
 * Mirror of the relay's capability matrix (server/relay/workspaces.ts), used
 * only to decide which controls to show. The relay decides what is allowed.
 */
export function can(role: WorkspaceRole | null | undefined, action: WorkspaceAction): boolean {
  return role != null && MATRIX[action].includes(role)
}

/** May this role change a member who holds `target`, e.g. to `next`? */
export function canManageMember(actor: WorkspaceRole, target: WorkspaceRole, next?: WorkspaceRole): boolean {
  if (!can(actor, 'member.manage')) return false
  const privileged = (r: WorkspaceRole) => r === 'owner' || r === 'admin'
  return !(privileged(target) || (next !== undefined && privileged(next))) || can(actor, 'member.manage_privileged')
}

export const ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
}

/** A relay refusal, with its machine-readable reason when there is one. */
export class WorkspaceRequestError extends Error {
  readonly status: number
  readonly code: string | null

  constructor(status: number, code: string | null, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

const REASONS: Record<string, string> = {
  last_owner: 'A workspace needs at least one owner. Make someone else an owner first.',
  invalid_owner: 'That person cannot own machines here (viewers cannot).',
  not_a_member: 'You are no longer a member of this workspace.',
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    const code = body?.error ?? null
    throw new WorkspaceRequestError(res.status, code, (code && REASONS[code]) ?? code ?? `Request failed (${res.status})`)
  }
  return (await res.json()) as T
}

const ws = (id: string) => `/api/workspaces/${encodeURIComponent(id)}`

export async function createWorkspace(name: string): Promise<Workspace> {
  const { workspace } = await call<{ workspace: Workspace }>('/api/workspaces', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
  return workspace
}

export async function renameWorkspace(id: string, name: string): Promise<void> {
  await call(ws(id), { method: 'PATCH', body: JSON.stringify({ name }) })
}

export async function deleteWorkspace(id: string): Promise<void> {
  await call(ws(id), { method: 'DELETE' })
}

export async function fetchMembers(id: string): Promise<WorkspaceMember[]> {
  return (await call<{ members: WorkspaceMember[] }>(`${ws(id)}/members`)).members
}

export async function updateMember(
  id: string,
  userId: string,
  change: { role?: WorkspaceRole; status?: 'active' | 'suspended' },
): Promise<void> {
  await call(`${ws(id)}/members/${encodeURIComponent(userId)}`, { method: 'PATCH', body: JSON.stringify(change) })
}

/** Remove a member, or leave when `userId` is the caller. */
export async function removeMember(id: string, userId: string): Promise<void> {
  await call(`${ws(id)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' })
}

export async function fetchWorkspaceMachines(id: string): Promise<WorkspaceMachine[]> {
  return (await call<{ machines: WorkspaceMachine[] }>(`${ws(id)}/machines`)).machines
}

export async function transferMachine(id: string, machineId: string, userId: string): Promise<void> {
  await call(`${ws(id)}/machines/${encodeURIComponent(machineId)}/transfer`, {
    method: 'POST',
    body: JSON.stringify({ userId }),
  })
}

export async function removeWorkspaceMachine(id: string, machineId: string): Promise<void> {
  await call(`${ws(id)}/machines/${encodeURIComponent(machineId)}`, { method: 'DELETE' })
}
