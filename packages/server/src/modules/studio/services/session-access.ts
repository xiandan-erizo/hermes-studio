/**
 * Unified Session authorization.
 *
 * Profile access is checked by the HTTP/Socket caller first. Within an allowed
 * Profile, a Session is private to its creator; only super_admin may access
 * every user's Session. External channel history remains read-only when its
 * actor identity is mapped to the current Studio user.
 *
 * `owner_user_id` is the authorization field. The legacy mixed-semantics
 * `user_id` is used only to resolve an external channel actor.
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

export function resolveSessionAccess(
  user: SessionAccessUser | null | undefined,
  session: (SessionOwnershipFields & HermesHistoryFields) | null | undefined,
): SessionAccess {
  if (!user || !session) return 'none'
  if (user.role === 'super_admin') return 'full'
  if (session.owner_user_id != null && Number(session.owner_user_id) === Number(user.id)) return 'full'
  const mapped = resolveExternalActorUser(session)
  if (mapped && Number(mapped.id) === Number(user.id)) return 'read_external'
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

/**
 * Inheritable identity propagated from an ancestor to identity-less
 * subagent sessions, keeping rows self-contained for resolveSessionAccess.
 */
export interface InheritedSessionIdentity {
  owner_user_id?: number | string | null
  external_actor_source?: string
  external_actor_id?: string
}

type InheritableSession = SessionOwnershipFields & HermesHistoryFields & { id: string | number; parent_session_id?: string | number | null }

function identityOfSession(session: InheritableSession | null | undefined): InheritedSessionIdentity | null {
  if (!session) return null
  const identity: InheritedSessionIdentity = {}
  if (session.owner_user_id != null) identity.owner_user_id = session.owner_user_id
  const actor = externalActorOf(session)
  if (actor) {
    identity.external_actor_source = actor.source
    identity.external_actor_id = actor.externalId
  } else if (session.external_actor_source && session.external_actor_id) {
    identity.external_actor_source = session.external_actor_source
    identity.external_actor_id = session.external_actor_id
  }
  return identity.owner_user_id != null || identity.external_actor_source ? identity : null
}

/**
 * Subagent sessions carry no identity of their own (user_id NULL in state.db,
 * no local owner). They inherit visibility from the nearest ancestor that
 * has one, so a session owner (or mapped channel actor) also sees the
 * subagent rows spawned by their conversation.
 *
 * Pure in-memory pass over a merged session list — call before ownership
 * filtering. Chains follow parent_session_id with cycle protection; rows
 * that already carry an identity are left untouched.
 */
export function inheritSessionIdentities<T extends { id: string | number; parent_session_id?: string | number | null }>(sessions: T[]): T[] {
  const byId = new Map<string, any>()
  for (const session of sessions) {
    if (session && session.id != null) byId.set(String(session.id), session)
  }
  const memo = new Map<string, InheritedSessionIdentity | null>()

  const resolve = (id: string, seen: Set<string>): InheritedSessionIdentity | null => {
    if (memo.has(id)) return memo.get(id) ?? null
    if (seen.has(id)) return null
    const row = byId.get(id)
    if (!row) return null
    const own = identityOfSession(row)
    if (own) {
      memo.set(id, own)
      return own
    }
    seen.add(id)
    const inherited = row.parent_session_id != null && String(row.parent_session_id) !== ''
      ? resolve(String(row.parent_session_id), seen)
      : null
    memo.set(id, inherited)
    return inherited
  }

  return sessions.map(session => {
    if (!session || session.id == null) return session
    const identity = resolve(String(session.id), new Set())
    if (!identity) return session
    const next: any = { ...session }
    if (next.owner_user_id == null && identity.owner_user_id != null) next.owner_user_id = identity.owner_user_id
    if (!next.external_actor_source && identity.external_actor_source) {
      next.external_actor_source = identity.external_actor_source
      next.external_actor_id = identity.external_actor_id
    }
    return next as T
  })
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
