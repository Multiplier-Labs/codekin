/**
 * Workspace invitations (docs/HOSTED-WORKSPACES-AND-MFA-PLAN.md, Phase 2).
 *
 * An invitation is a single-use link bound to one recipient — a verified
 * email address or an immutable GitHub account id — and to a role. Only the
 * SHA-256 of its token is stored; the link is shown to the inviter once.
 * Acceptance happens only inside the GitHub OAuth callback, the one place the
 * relay learns the caller's GitHub id and verified emails first-hand, and a
 * valid invitation is also how a new account gets past the env allowlist.
 *
 * Authority is re-checked at acceptance: an invitation from someone who has
 * since lost the right to issue it (removed, suspended, demoted) no longer
 * works, and neither does one into a deleted workspace.
 */

import { randomBytes, randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { sha256Hex } from './pairing.js'
import type { WorkspaceRole } from './control-plane-db.js'
import { can, getActiveMembership, getWorkspace, isPrivilegedRole } from './workspaces.js'

/** Invitations expire a week after they are issued. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Bound on outstanding invitations per workspace, so one cannot be flooded. */
export const MAX_PENDING_INVITATIONS = 100

export type InvitableRole = Exclude<WorkspaceRole, 'owner'>
export const INVITABLE_ROLES: InvitableRole[] = ['admin', 'member', 'viewer']

interface InvitationRow {
  id: string
  workspace_id: string
  role: InvitableRole
  invitee_email: string | null
  invitee_github_id: number | null
  invitee_github_login: string | null
  token_hash: string
  invited_by_user_id: string
  created_at: string
  expires_at: number
  accepted_at: string | null
  accepted_by_user_id: string | null
  revoked_at: string | null
}

export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired'

export interface Invitation {
  id: string
  workspaceId: string
  role: InvitableRole
  inviteeEmail: string | null
  inviteeGithubId: number | null
  inviteeGithubLogin: string | null
  invitedByUserId: string
  createdAt: string
  expiresAt: number
  status: InvitationStatus
}

function statusOf(row: InvitationRow, now = Date.now()): InvitationStatus {
  if (row.accepted_at) return 'accepted'
  if (row.revoked_at) return 'revoked'
  return row.expires_at <= now ? 'expired' : 'pending'
}

function toInvitation(row: InvitationRow): Invitation {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    role: row.role,
    inviteeEmail: row.invitee_email,
    inviteeGithubId: row.invitee_github_id,
    inviteeGithubLogin: row.invitee_github_login,
    invitedByUserId: row.invited_by_user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status: statusOf(row),
  }
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase()
}

/** Loose shape check; GitHub's verified-email list is the real proof. */
export function isPlausibleEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

export interface InvitationRecipient {
  email?: string
  github?: { id: number; login: string }
}

export type CreateInvitationResult =
  | { ok: true; invitation: Invitation; token: string }
  | { ok: false; reason: 'too_many_pending' }

/**
 * Issue an invitation. Any still-pending invitation to the same recipient in
 * the same workspace is revoked first, so there is only ever one live link
 * per person.
 */
export function createInvitation(
  db: Database.Database,
  input: { workspaceId: string; role: InvitableRole; recipient: InvitationRecipient; invitedByUserId: string },
): CreateInvitationResult {
  const email = input.recipient.email ? normalizeEmail(input.recipient.email) : null
  const github = input.recipient.github ?? null
  return db.transaction((): CreateInvitationResult => {
    db.prepare(
      `UPDATE workspace_invitations SET revoked_at = datetime('now')
       WHERE workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL
         AND ((? IS NOT NULL AND invitee_email = ?) OR (? IS NOT NULL AND invitee_github_id = ?))`,
    ).run(input.workspaceId, email, email, github?.id ?? null, github?.id ?? null)

    const pending = db
      .prepare(
        `SELECT COUNT(*) AS n FROM workspace_invitations
         WHERE workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
      )
      .get(input.workspaceId, Date.now()) as { n: number }
    if (pending.n >= MAX_PENDING_INVITATIONS) return { ok: false, reason: 'too_many_pending' }

    const id = randomUUID()
    const token = randomBytes(32).toString('base64url')
    db.prepare(
      `INSERT INTO workspace_invitations
         (id, workspace_id, role, invitee_email, invitee_github_id, invitee_github_login, token_hash, invited_by_user_id, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.workspaceId,
      input.role,
      email,
      github?.id ?? null,
      github?.login ?? null,
      sha256Hex(token),
      input.invitedByUserId,
      Date.now() + INVITATION_TTL_MS,
    )
    return { ok: true, invitation: getInvitation(db, id) as Invitation, token }
  })()
}

export function getInvitation(db: Database.Database, id: string): Invitation | undefined {
  const row = db.prepare('SELECT * FROM workspace_invitations WHERE id = ?').get(id) as InvitationRow | undefined
  return row ? toInvitation(row) : undefined
}

/** Outstanding (pending, unexpired) invitations of a workspace, newest first. */
export function listPendingInvitations(db: Database.Database, workspaceId: string): Invitation[] {
  return (
    db
      .prepare(
        `SELECT * FROM workspace_invitations
         WHERE workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?
         ORDER BY created_at DESC, id`,
      )
      .all(workspaceId, Date.now()) as InvitationRow[]
  ).map(toInvitation)
}

export function revokeInvitation(db: Database.Database, workspaceId: string, id: string): boolean {
  return (
    db
      .prepare(
        `UPDATE workspace_invitations SET revoked_at = datetime('now')
         WHERE id = ? AND workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
      )
      .run(id, workspaceId).changes > 0
  )
}

/** Why an invitation cannot be used, or null when it can. */
function unusableReason(db: Database.Database, row: InvitationRow): 'invalid' | null {
  if (statusOf(row) !== 'pending') return 'invalid'
  if (!getWorkspace(db, row.workspace_id)) return 'invalid'
  // The inviter must still hold the right to issue this invitation.
  const inviter = getActiveMembership(db, row.workspace_id, row.invited_by_user_id)
  const inviterAccount = db.prepare('SELECT status FROM users WHERE id = ?').get(row.invited_by_user_id) as
    | { status: string }
    | undefined
  if (!inviter || inviterAccount?.status !== 'active' || !can(inviter.role, 'member.invite')) return 'invalid'
  if (isPrivilegedRole(row.role) && !can(inviter.role, 'member.manage_privileged')) return 'invalid'
  return null
}

function findByToken(db: Database.Database, token: string): InvitationRow | undefined {
  if (!token) return undefined
  return db.prepare('SELECT * FROM workspace_invitations WHERE token_hash = ?').get(sha256Hex(token)) as
    | InvitationRow
    | undefined
}

export interface InvitationPreview {
  workspaceName: string
  inviterLogin: string | null
  role: InvitableRole
  expiresAt: number
  /** How the recipient is identified — the value itself is not disclosed. */
  boundTo: 'email' | 'github'
  /** For a GitHub-bound invitation: the account it is for (already public). */
  githubLogin: string | null
  status: InvitationStatus | 'unavailable'
}

/**
 * What the invitation landing page may show to whoever holds the link. The
 * bound email is withheld: the link could be forwarded, and the address is
 * the recipient's business.
 */
export function previewInvitation(db: Database.Database, token: string): InvitationPreview | null {
  const row = findByToken(db, token)
  if (!row) return null
  const workspace = db.prepare('SELECT name FROM workspaces WHERE id = ?').get(row.workspace_id) as { name: string }
  const inviter = db.prepare('SELECT login FROM users WHERE id = ?').get(row.invited_by_user_id) as
    | { login: string }
    | undefined
  const status = statusOf(row)
  return {
    workspaceName: workspace.name,
    inviterLogin: inviter?.login ?? null,
    role: row.role,
    expiresAt: row.expires_at,
    boundTo: row.invitee_github_id !== null ? 'github' : 'email',
    githubLogin: row.invitee_github_login,
    status: status === 'pending' && unusableReason(db, row) ? 'unavailable' : status,
  }
}

/** Whether a token names an invitation that could be accepted right now. */
export function isInvitationUsable(db: Database.Database, token: string): boolean {
  const row = findByToken(db, token)
  return row !== undefined && unusableReason(db, row) === null
}

export interface GithubIdentity {
  githubId: number
  /** Only emails GitHub reports as verified. */
  verifiedEmails: string[]
}

/** Does this signed-in GitHub identity match the invitation's recipient? */
export function identityMatches(
  invitation: Pick<InvitationRow, 'invitee_email' | 'invitee_github_id'>,
  identity: GithubIdentity,
): boolean {
  if (invitation.invitee_github_id !== null && invitation.invitee_github_id !== identity.githubId) return false
  if (invitation.invitee_email !== null) {
    const verified = new Set(identity.verifiedEmails.map(normalizeEmail))
    if (!verified.has(invitation.invitee_email)) return false
  }
  return true
}

export type InvitationCheck =
  | { ok: true; invitationId: string; workspaceId: string; role: InvitableRole }
  | { ok: false; reason: 'invite_invalid' | 'invite_mismatch' }

/** Validate a token for this identity without consuming it (admission check). */
export function checkInvitation(db: Database.Database, token: string, identity: GithubIdentity): InvitationCheck {
  const row = findByToken(db, token)
  if (!row || unusableReason(db, row)) return { ok: false, reason: 'invite_invalid' }
  if (!identityMatches(row, identity)) return { ok: false, reason: 'invite_mismatch' }
  return { ok: true, invitationId: row.id, workspaceId: row.workspace_id, role: row.role }
}

export type AcceptInvitationResult =
  | { ok: true; workspaceId: string; role: WorkspaceRole; alreadyMember: boolean }
  | { ok: false; reason: 'invite_invalid' | 'invite_mismatch' }

/**
 * Consume an invitation for a signed-in user and add the membership, in one
 * transaction: the usability check, the single-use claim and the insert
 * cannot interleave with a concurrent acceptance or revocation. An existing
 * membership is left exactly as it is (a suspended member is not reinstated
 * by an old link); the invitation is still marked used.
 */
export function acceptInvitation(
  db: Database.Database,
  token: string,
  userId: string,
  identity: GithubIdentity,
): AcceptInvitationResult {
  return db.transaction((): AcceptInvitationResult => {
    const check = checkInvitation(db, token, identity)
    if (!check.ok) return check
    const claimed = db
      .prepare(
        `UPDATE workspace_invitations SET accepted_at = datetime('now'), accepted_by_user_id = ?
         WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
      )
      .run(userId, check.invitationId, Date.now())
    if (claimed.changes === 0) return { ok: false, reason: 'invite_invalid' }

    const existing = db
      .prepare('SELECT role FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?')
      .get(check.workspaceId, userId) as { role: WorkspaceRole } | undefined
    if (existing) return { ok: true, workspaceId: check.workspaceId, role: existing.role, alreadyMember: true }

    const inviter = db.prepare('SELECT invited_by_user_id FROM workspace_invitations WHERE id = ?').get(
      check.invitationId,
    ) as { invited_by_user_id: string }
    db.prepare(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role, invited_by_user_id) VALUES (?, ?, ?, ?)`,
    ).run(check.workspaceId, userId, check.role, inviter.invited_by_user_id)
    return { ok: true, workspaceId: check.workspaceId, role: check.role, alreadyMember: false }
  })()
}
