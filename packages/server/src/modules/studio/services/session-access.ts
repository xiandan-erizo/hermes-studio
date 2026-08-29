/**
 * Unified session authorization (P0).
 *
 * Single source of truth for who may read / operate a Studio session.
 * Authorization is based on `owner_user_id` (see session-ownership.ts) --
 * the legacy mixed-semantics `user_id` column is NEVER consulted here.
 *
 * Access matrix (phase 1):
 *
 *   subject                          read   operate
 *   -------------------------------  -----  -------
 *   owner_user_id === user.id         yes    yes
 *   super_admin                       yes    yes   (explicit management capability)
 *   admin (profile history review)   yes     no
 *   plain 'user', external identity
 *   reliably mapped                  (reserved: readExternalHistory)
 *   anything else                      no     no
 *
 * `readExternalHistory` is intentionally a reserved capability: personal
 * channel history (feishu/dingtalk) will surface through a future read-only
 * view driven by external_actor_* mapping, not by granting owners. Keep this
 * hook so repository queries can ask for it without hardcoding "owner-less
 * sessions are invisible" everywhere.
 */

export type SessionAccess = 'full' | 'read_external' | 'none'

export interface SessionAccessUser {
  id: number | string
  role?: string
}

export interface SessionOwnershipFields {
  owner_user_id?: number | null
  ownership_state?: string | null
  external_actor_source?: string | null
  external_actor_id?: string | null
}

/** Reserved for future external-history read-only access. Returns the mapped
 *  Studio user for an external actor, or null when no reliable mapping
 *  exists. Phase 1: no mappings, always null. */
export function resolveExternalActorUser(_session: SessionOwnershipFields): SessionAccessUser | null {
  return null
}

export function resolveSessionAccess(
  user: SessionAccessUser | null | undefined,
  session: SessionOwnershipFields | null | undefined,
): SessionAccess {
  if (!session) return 'none'
  if (user && session.owner_user_id != null && Number(session.owner_user_id) === Number(user.id)) {
    return 'full'
  }
  if (user?.role === 'super_admin') return 'full'
  if (user?.role === 'admin') return 'read_external'
  // Plain 'user' without ownership: external history is a future read-only
  // capability; local operation is never allowed.
  return 'none'
}

export function canReadSession(user: SessionAccessUser | null | undefined, session: SessionOwnershipFields | null | undefined): boolean {
  return resolveSessionAccess(user, session) !== 'none'
}

export function canOperateSession(user: SessionAccessUser | null | undefined, session: SessionOwnershipFields | null | undefined): boolean {
  return resolveSessionAccess(user, session) === 'full'
}

export type DenyContext = {
  state?: { user?: SessionAccessUser | null } | any
  status?: number
  body?: unknown
}

/** Koa-style read gate. 404 (not 403) to avoid leaking session existence. */
export function denySessionRead(ctx: DenyContext, session: SessionOwnershipFields | null | undefined): boolean {
  if (canReadSession(ctx.state?.user, session)) return false
  ctx.status = 404
  ctx.body = { error: 'Session not found' }
  return true
}

/** Koa-style operate gate: 404 when invisible, 403 when read-only. */
export function denySessionOperation(ctx: DenyContext, session: SessionOwnershipFields | null | undefined): boolean {
  const access = resolveSessionAccess(ctx.state?.user, session)
  if (access === 'full') return false
  if (access === 'read_external') {
    ctx.status = 403
    ctx.body = { error: 'Session is read-only for this account' }
    return true
  }
  ctx.status = 404
  ctx.body = { error: 'Session not found' }
  return true
}
