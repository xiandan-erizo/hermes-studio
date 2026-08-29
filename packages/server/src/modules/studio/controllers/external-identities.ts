import type { Context } from 'koa'
import { findUserById } from '../public/users'
import {
  createExternalIdentity,
  deleteExternalIdentity,
  listExternalIdentities,
  isChannelSource,
} from '../repositories/external-identities-store'
import { listSessionSummaries } from '../../hermes/services/history/sessions-db'

/**
 * GET /api/auth/external-identities (admin)
 * Channel identity mappings plus unmapped candidates seen in Hermes history.
 */
export async function listMappings(ctx: Context) {
  const mappings = listExternalIdentities().map(mapping => ({
    ...mapping,
    username: findUserById(mapping.user_id)?.username || null,
  }))
  ctx.body = { mappings }
}

export async function listCandidates(ctx: Context) {
  let candidates: Array<{ source: string; external_id: string; session_count: number }> = []
  try {
    const sessions = await listSessionSummaries(undefined, 5000)
    const counts = new Map<string, { source: string; external_id: string; session_count: number }>()
    for (const session of sessions) {
      if (!isChannelSource(session.source)) continue
      const externalId = (session.user_id || '').trim()
      if (!externalId) continue
      const key = `${session.source}:${externalId}`
      const entry = counts.get(key)
      if (entry) entry.session_count += 1
      else counts.set(key, { source: String(session.source), external_id: externalId, session_count: 1 })
    }
    candidates = [...counts.values()].sort((a, b) => b.session_count - a.session_count)
  } catch (err) {
    // Hermes state.db unavailable: return an empty candidate list, not an error.
    candidates = []
  }
  ctx.body = { candidates }
}

/**
 * POST /api/auth/external-identities (admin)
 * Body: { source, external_id, user_id, note? }
 */
export async function createMapping(ctx: Context) {
  const body = ctx.request.body as {
    source?: unknown
    external_id?: unknown
    user_id?: unknown
    note?: unknown
  } | undefined
  const source = String(body?.source || '').trim()
  const externalId = String(body?.external_id || '').trim()
  const userId = Number(body?.user_id)
  if (!isChannelSource(source)) {
    ctx.status = 400
    ctx.body = { error: 'source must be one of feishu/dingtalk/weixin/wecom/webhook' }
    return
  }
  if (!externalId) {
    ctx.status = 400
    ctx.body = { error: 'external_id is required' }
    return
  }
  if (!Number.isInteger(userId) || userId <= 0 || !findUserById(userId)) {
    ctx.status = 400
    ctx.body = { error: 'user_id must reference an existing user' }
    return
  }
  const result = createExternalIdentity({
    source,
    externalId,
    userId,
    note: typeof body?.note === 'string' ? body.note.slice(0, 200) : undefined,
  })
  if (result == null) {
    ctx.status = 400
    ctx.body = { error: 'Invalid mapping' }
    return
  }
  if ('conflict' in result) {
    ctx.status = 409
    ctx.body = { error: 'A mapping for this source and external_id already exists' }
    return
  }
  ctx.status = 201
  ctx.body = { mapping: { ...result, username: findUserById(userId)?.username || null } }
}

/**
 * DELETE /api/auth/external-identities/:id (admin)
 */
export async function removeMapping(ctx: Context) {
  const id = Number(ctx.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    ctx.status = 400
    ctx.body = { error: 'Invalid mapping id' }
    return
  }
  if (!deleteExternalIdentity(id)) {
    ctx.status = 404
    ctx.body = { error: 'Mapping not found' }
    return
  }
  ctx.body = { success: true }
}
