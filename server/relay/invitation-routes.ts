/**
 * Invitation endpoints (docs/HOSTED-WORKSPACES-AND-MFA-PLAN.md, Phase 2).
 *
 * Owners and admins issue, list, resend and revoke invitations for their
 * workspace. The link carries the token in its fragment (`/invite#<token>`),
 * so it never reaches access logs or Referer headers; the landing page posts
 * it to `lookup` to show what it is, then to `prepare`, which parks it in the
 * session for the GitHub round trip. Acceptance itself happens in the OAuth
 * callback (relay-auth-routes.ts), where the caller's GitHub id and verified
 * emails are known first-hand.
 */

import { Router } from 'express'
import type { Request, Response } from 'express'
import type Database from 'better-sqlite3'
import type { RelayConfig } from './relay-config.js'
import { createRequireActiveUser, saveSession } from './relay-auth-routes.js'
import { can, getActiveMembership } from './workspaces.js'
import type { Membership } from './workspaces.js'
import {
  INVITABLE_ROLES,
  createInvitation,
  getInvitation,
  isInvitationUsable,
  isPlausibleEmail,
  listPendingInvitations,
  previewInvitation,
  revokeInvitation,
} from './invitations.js'
import type { Invitation, InvitableRole, InvitationRecipient } from './invitations.js'
import { recordAuditEvent } from './audit.js'

declare module 'express-session' {
  interface SessionData {
    /** An invitation token awaiting the GitHub sign-in that will accept it. */
    pendingInviteToken?: string
  }
}

const GITHUB_USERS_URL = 'https://api.github.com/users/'
/** GitHub's username rules: alphanumerics and single hyphens, at most 39. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/
const MAX_TOKEN_LENGTH = 128

export interface InvitationRouterDeps {
  db: Database.Database
  config: RelayConfig
  /** Injectable for tests; resolves GitHub usernames to their immutable id. */
  fetchImpl?: typeof fetch
}

export function createInvitationRouter({ db, config, fetchImpl = fetch }: InvitationRouterDeps): Router {
  const router = Router()
  const requireActiveUser = createRequireActiveUser(db)

  const audit = (req: Request) => ({ ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null })
  const linkFor = (token: string) => `${config.publicUrl}/invite#${token}`

  /** The caller's membership in `:id` if they may manage invitations there; otherwise the response is sent. */
  const inviter = (req: Request, res: Response): Membership | null => {
    const membership = getActiveMembership(db, String(req.params.id), req.session.user?.id ?? '')
    if (!membership) {
      res.status(404).json({ error: 'Workspace not found' })
      return null
    }
    if (!can(membership.role, 'member.invite')) {
      res.status(403).json({ error: 'Not permitted in this workspace' })
      return null
    }
    return membership
  }

  const mayInviteAs = (membership: Membership, role: InvitableRole) =>
    role !== 'admin' || can(membership.role, 'member.manage_privileged')

  /** Resolve a GitHub username to its numeric id, which — unlike the name — cannot change hands. */
  async function resolveGithubUser(login: string): Promise<{ id: number; login: string } | 'not_found' | 'unavailable'> {
    try {
      const res = await fetchImpl(GITHUB_USERS_URL + encodeURIComponent(login), {
        headers: { Accept: 'application/vnd.github+json' },
      })
      if (res.status === 404) return 'not_found'
      if (!res.ok) return 'unavailable'
      const data = (await res.json()) as { id?: unknown; login?: unknown; type?: unknown }
      if (typeof data.id !== 'number' || typeof data.login !== 'string') return 'unavailable'
      if (data.type !== undefined && data.type !== 'User') return 'not_found'
      return { id: data.id, login: data.login }
    } catch {
      return 'unavailable'
    }
  }

  const view = (invitation: Invitation) => ({
    id: invitation.id,
    role: invitation.role,
    email: invitation.inviteeEmail,
    githubLogin: invitation.inviteeGithubLogin,
    invitedByUserId: invitation.invitedByUserId,
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
    status: invitation.status,
  })

  router.post('/api/workspaces/:id/invitations', requireActiveUser, (req, res, next) => {
    void (async () => {
      const membership = inviter(req, res)
      if (!membership) return
      const body = (req.body ?? {}) as { role?: unknown; email?: unknown; githubLogin?: unknown }
      const role = body.role as InvitableRole
      if (!INVITABLE_ROLES.includes(role)) {
        res.status(400).json({ error: `role must be one of: ${INVITABLE_ROLES.join(', ')}` })
        return
      }
      if (!mayInviteAs(membership, role)) {
        res.status(403).json({ error: 'Only an owner can invite an admin' })
        return
      }

      const email = typeof body.email === 'string' ? body.email.trim() : ''
      const githubLogin = typeof body.githubLogin === 'string' ? body.githubLogin.trim().replace(/^@/, '') : ''
      if ((email ? 1 : 0) + (githubLogin ? 1 : 0) !== 1) {
        res.status(400).json({ error: 'Provide exactly one of email or githubLogin' })
        return
      }

      const recipient: InvitationRecipient = {}
      if (email) {
        if (!isPlausibleEmail(email)) {
          res.status(400).json({ error: 'invalid_email' })
          return
        }
        recipient.email = email
      } else {
        if (!GITHUB_LOGIN.test(githubLogin)) {
          res.status(400).json({ error: 'invalid_github_login' })
          return
        }
        const resolved = await resolveGithubUser(githubLogin)
        if (resolved === 'not_found') {
          res.status(400).json({ error: 'github_user_not_found' })
          return
        }
        if (resolved === 'unavailable') {
          res.status(502).json({ error: 'github_unavailable' })
          return
        }
        const existing = db
          .prepare(
            `SELECT 1 FROM workspace_memberships m JOIN users u ON u.id = m.user_id
             WHERE m.workspace_id = ? AND u.github_id = ?`,
          )
          .get(membership.workspaceId, resolved.id)
        if (existing) {
          res.status(409).json({ error: 'already_member' })
          return
        }
        recipient.github = resolved
      }

      const result = createInvitation(db, {
        workspaceId: membership.workspaceId,
        role,
        recipient,
        invitedByUserId: membership.userId,
      })
      if (!result.ok) {
        res.status(429).json({ error: result.reason })
        return
      }
      recordAuditEvent(db, {
        kind: 'invitation_created',
        workspaceId: membership.workspaceId,
        actorUserId: membership.userId,
        ...audit(req),
        metadata: {
          invitationId: result.invitation.id,
          role,
          boundTo: recipient.github ? 'github' : 'email',
          githubLogin: recipient.github?.login ?? null,
        },
      })
      res.status(201).json({ invitation: view(result.invitation), inviteUrl: linkFor(result.token) })
    })().catch(next)
  })

  router.get('/api/workspaces/:id/invitations', requireActiveUser, (req, res) => {
    const membership = inviter(req, res)
    if (!membership) return
    res.json({ invitations: listPendingInvitations(db, membership.workspaceId).map(view) })
  })

  router.delete('/api/workspaces/:id/invitations/:invitationId', requireActiveUser, (req, res) => {
    const membership = inviter(req, res)
    if (!membership) return
    const invitationId = String(req.params.invitationId)
    const invitation = getInvitation(db, invitationId)
    if (!invitation || invitation.workspaceId !== membership.workspaceId) {
      res.status(404).json({ error: 'Invitation not found' })
      return
    }
    if (!mayInviteAs(membership, invitation.role)) {
      res.status(403).json({ error: 'Only an owner can revoke an admin invitation' })
      return
    }
    if (!revokeInvitation(db, membership.workspaceId, invitationId)) {
      res.status(409).json({ error: 'Invitation is no longer pending' })
      return
    }
    recordAuditEvent(db, {
      kind: 'invitation_revoked',
      workspaceId: membership.workspaceId,
      actorUserId: membership.userId,
      ...audit(req),
      metadata: { invitationId },
    })
    res.json({ success: true })
  })

  /** A fresh link for the same recipient and role; the old link stops working. */
  router.post('/api/workspaces/:id/invitations/:invitationId/resend', requireActiveUser, (req, res) => {
    const membership = inviter(req, res)
    if (!membership) return
    const previous = getInvitation(db, String(req.params.invitationId))
    if (!previous || previous.workspaceId !== membership.workspaceId || previous.status === 'accepted') {
      res.status(404).json({ error: 'Invitation not found' })
      return
    }
    if (!mayInviteAs(membership, previous.role)) {
      res.status(403).json({ error: 'Only an owner can invite an admin' })
      return
    }
    const result = createInvitation(db, {
      workspaceId: membership.workspaceId,
      role: previous.role,
      recipient: {
        email: previous.inviteeEmail ?? undefined,
        github:
          previous.inviteeGithubId !== null
            ? { id: previous.inviteeGithubId, login: previous.inviteeGithubLogin ?? '' }
            : undefined,
      },
      invitedByUserId: membership.userId,
    })
    if (!result.ok) {
      res.status(429).json({ error: result.reason })
      return
    }
    recordAuditEvent(db, {
      kind: 'invitation_created',
      workspaceId: membership.workspaceId,
      actorUserId: membership.userId,
      ...audit(req),
      metadata: { invitationId: result.invitation.id, resentFrom: previous.id, role: previous.role },
    })
    res.status(201).json({ invitation: view(result.invitation), inviteUrl: linkFor(result.token) })
  })

  const tokenFrom = (req: Request): string | null => {
    const token = (req.body as { token?: unknown } | undefined)?.token
    return typeof token === 'string' && token.length > 0 && token.length <= MAX_TOKEN_LENGTH ? token : null
  }

  /** Public: what an invitation link is, for whoever holds it. */
  router.post('/api/invitations/lookup', (req, res) => {
    const token = tokenFrom(req)
    const preview = token ? previewInvitation(db, token) : null
    if (!preview) {
      res.status(404).json({ error: 'invite_invalid' })
      return
    }
    res.json({ invitation: preview })
  })

  /**
   * Public: park a usable token in the session so the GitHub callback can
   * accept it. The browser goes to /api/auth/github/start next.
   */
  router.post('/api/invitations/prepare', (req, res, next) => {
    const token = tokenFrom(req)
    if (!token || !isInvitationUsable(db, token)) {
      res.status(410).json({ error: 'invite_invalid' })
      return
    }
    req.session.pendingInviteToken = token
    saveSession(req)
      .then(() => { res.json({ success: true }) })
      .catch(next)
  })

  return router
}
