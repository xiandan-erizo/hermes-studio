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

/** Fields carried by Hermes state.db history rows (channel sessions). */
export interface HermesHistoryFields {
  source?: string | null
  user_id?: string | number | null
}

export type SessionAccess = 'full' | 'read_external' | 'none'

import { findMappedUserId, isChannelSource } from '../repositories/external-identities-store'
import { findUserById } from '../repositories/users-store'

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

/**
 * External-actor mapping: returns the Studio user a channel actor maps to,
 * or null. The mapping lives in external_identities (admin-managed).
 * Accepts both Studio session shape (external_actor_*) and Hermes state.db
 * history shape (channel source + user_id).
 */
export function resolveExternalActorUser(session: SessionOwnershipFields | HermesHistoryFields | null | undefined): SessionAccessUser | null {
  const actor = externalActorOf(session)
  if (!actor) return null
  const userId = findMappedUserId(actor.source, actor.externalId)
  if (userId == null) return null
  const user = findUserById(userId)
  if (!user || user.status !== 'active') return null
  return { id: user.id, role: user.role }
}

/** Normalized external actor for a session row (either shape). */
export interface ExternalActor {
  source: string
  externalId: string
}

export function externalActorOf(
  session: (SessionOwnershipFields & HermesHistoryFields) | null | undefined,
): ExternalActor | null {
  if (!session) return null
  if (session.external_actor_source && session.external_actor_id) {
    return { source: String(session.external_actor_source), externalId: String(session.external_actor_id) }
  }
  // Hermes state.db history shape: channel source + user_id
  if (isChannelSource(session.source) && session.user_id != null && String(session.user_id).trim() !== '') {
    return { source: String(session.source).toLowerCase(), externalId: String(session.user_id).trim() }
  }
  return null
}

/**
 * Session authorization is Profile-scoped. Callers must verify that the user
 * can access the Session's Profile before consulting this helper. Ownership
 * fields remain audit metadata and do not restrict collaboration within a
 * Profile.
 */
export function resolveSessionAccess(
  user: SessionAccessUser | null | undefined,
  session: (SessionOwnershipFields & HermesHistoryFields) | null | undefined,
): SessionAccess {
  return user && session ? 'full' : 'none'
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
