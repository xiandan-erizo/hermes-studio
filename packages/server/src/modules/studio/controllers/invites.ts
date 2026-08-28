import type { Context } from 'koa'
import { authenticateUserToken, issueUserJwt } from '../public/auth'
import {
  createUser,
  findUserById,
  findUserByUsername,
  listUserProfiles,
  addUserProfileBinding,
  touchUserLogin,
  type UserRecord,
} from '../public/users'
import { listProfileNamesFromDisk } from '../public/profile-config'
import {
  consumeInviteUse,
  createInvite,
  getInviteByCode,
  listInvites,
  revokeInvite,
  validateInviteForUse,
  DEFAULT_INVITE_EXPIRES_DAYS,
} from '../services/auth/profile-invites'

function inviteNotFound(ctx: Context, reason: 'not_found' | 'revoked' | 'expired'): void {
  if (reason === 'not_found') {
    ctx.status = 404
    ctx.body = { error: 'Invite not found' }
    return
  }
  ctx.status = 410
  ctx.body = { error: reason === 'revoked' ? 'Invite has been revoked' : 'Invite has expired' }
}

function inviteLinkUrl(ctx: Context, code: string): string {
  const forwardedHost = ctx.get('x-forwarded-host').split(',')[0].trim()
  const host = forwardedHost || ctx.get('host').trim()
  const forwardedProto = ctx.get('x-forwarded-proto').split(',')[0].trim()
  const proto = forwardedProto || ctx.protocol || 'http'
  const base = host ? `${proto}://${host}` : ''
  return `${base}/#/invite/${encodeURIComponent(code)}`
}

/**
 * GET /api/auth/invites/:code (public)
 * Validate an invitation code and show the target profile.
 */
export async function getInviteInfo(ctx: Context) {
  const code = String(ctx.params.code || '')
  const invite = getInviteByCode(code)
  if (!invite) {
    ctx.status = 404
    ctx.body = { error: 'Invite not found' }
    return
  }
  ctx.body = {
    invite: {
      code: invite.code,
      profile: invite.profile_name,
      status: invite.status,
      expires_at: invite.expires_at,
    },
  }
}

/**
 * POST /api/auth/invites/:code/accept (public)
 * Two modes:
 * - no credentials: { username, password } registers a fresh 'user' account
 *   bound to the invite profile and returns a session token
 * - Bearer user JWT: binds the invite profile to the current account
 */
export async function acceptInvite(ctx: Context) {
  const code = String(ctx.params.code || '')
  const validation = validateInviteForUse(code)
  if (!validation.ok) {
    inviteNotFound(ctx, validation.reason)
    return
  }
  const invite = validation.invite

  const authHeader = String(ctx.headers.authorization || '')
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  const body = ctx.request.body as { username?: unknown; password?: unknown } | undefined

  if (bearerToken) {
    const user = await authenticateUserToken(bearerToken)
    if (!user) {
      ctx.status = 401
      ctx.body = { error: 'Unauthorized' }
      return
    }
    const record = findUserById(user.id)
    if (!record || record.status !== 'active') {
      ctx.status = 403
      ctx.body = { error: 'User is disabled or does not exist' }
      return
    }
    if (record.role !== 'super_admin') {
      addUserProfileBinding(record.id, invite.profile_name, listUserProfiles(record.id).length === 0)
    }
    consumeInviteUse(code)
    ctx.body = {
      success: true,
      profile: invite.profile_name,
      profiles: record.role === 'super_admin'
        ? listProfileNamesFromDisk()
        : listUserProfiles(record.id).map(profile => profile.profile_name),
    }
    return
  }

  const username = String(body?.username || '').trim()
  const password = typeof body?.password === 'string' ? body.password : ''
  if (username.length < 2) {
    ctx.status = 400
    ctx.body = { error: 'Username must be at least 2 characters' }
    return
  }
  if (password.length < 6) {
    ctx.status = 400
    ctx.body = { error: 'Password must be at least 6 characters' }
    return
  }
  if (findUserByUsername(username)) {
    ctx.status = 409
    ctx.body = { error: 'Username already exists' }
    return
  }

  const user: UserRecord | null = createUser({
    username,
    password,
    role: 'user',
    status: 'active',
    profiles: [invite.profile_name],
    defaultProfile: invite.profile_name,
  })
  if (!user) {
    ctx.status = 500
    ctx.body = { error: 'Failed to create user' }
    return
  }
  consumeInviteUse(code)
  touchUserLogin(user.id)
  const token = await issueUserJwt(user)
  ctx.status = 201
  ctx.body = {
    token,
    userId: user.id,
    profile: invite.profile_name,
    profiles: [invite.profile_name],
  }
}

/**
 * GET /api/auth/invites (admin+)
 * List all invitations with usage stats.
 */
export async function listInviteRecords(ctx: Context) {
  ctx.body = {
    invites: listInvites().map(invite => ({
      ...invite,
      url: inviteLinkUrl(ctx, invite.code),
    })),
    profiles: listProfileNamesFromDisk(),
  }
}

/**
 * POST /api/auth/invites (admin+)
 * Create a multi-use invitation for a profile.
 * Body: { profile, expiresInDays?, maxUses? }
 */
export async function createInviteRecord(ctx: Context) {
  const body = ctx.request.body as {
    profile_name?: unknown
    profile?: unknown
    expiresInDays?: unknown
    maxUses?: unknown
  }
  const profile = String(body?.profile_name || body?.profile || '').trim()
  if (!profile) {
    ctx.status = 400
    ctx.body = { error: 'profile is required' }
    return
  }
  const expiresInDays = body?.expiresInDays == null ? DEFAULT_INVITE_EXPIRES_DAYS : Number(body.expiresInDays)
  const maxUses = body?.maxUses == null ? 0 : Number(body.maxUses)

  const result = createInvite({
    profileName: profile,
    createdByUserId: Number(ctx.state.user?.id || 0),
    expiresInDays,
    maxUses,
  })
  if (!result.ok) {
    ctx.status = 400
    ctx.body = { error: result.error }
    return
  }
  ctx.status = 201
  ctx.body = {
    invite: {
      ...result.invite,
      url: inviteLinkUrl(ctx, result.invite.code),
    },
    invites: listInvites().map(invite => ({
      ...invite,
      url: inviteLinkUrl(ctx, invite.code),
    })),
  }
}

/**
 * DELETE /api/auth/invites/:code (admin+)
 * Revoke an invitation.
 */
export async function revokeInviteRecord(ctx: Context) {
  const code = String(ctx.params.code || '')
  const invite = getInviteByCode(code)
  if (!invite) {
    ctx.status = 404
    ctx.body = { error: 'Invite not found' }
    return
  }
  if (invite.status === 'revoked') {
    ctx.status = 409
    ctx.body = { error: 'Invite has already been revoked' }
    return
  }
  revokeInvite(code)
  ctx.body = {
    success: true,
    invites: listInvites().map(item => ({
      ...item,
      url: inviteLinkUrl(ctx, item.code),
    })),
  }
}
