import { findUserById, listUsers } from '../public/users'
import { listHermesSessionSummaries } from '../public/session-agent-runtime'
import {
  createExternalIdentity,
  deleteExternalIdentity,
  listExternalIdentities,
  isChannelSource,
} from '../repositories/external-identities-store'

export class ExternalIdentityError extends Error {
  constructor(message: string, readonly code: 'invalid' | 'conflict' | 'not_found') {
    super(message)
  }
}

export interface ExternalIdentityInput {
  source?: unknown
  external_id?: unknown
  user_id?: unknown
  note?: unknown
}

export function listMappings() {
  return listExternalIdentities().map(mapping => ({
    ...mapping,
    username: findUserById(mapping.user_id)?.username || null,
  }))
}

export async function listCandidates() {
  const counts = new Map<string, { source: string; external_id: string; session_count: number }>()
  try {
    const sessions = await listHermesSessionSummaries(undefined, 5000)
    for (const session of sessions) {
      if (!isChannelSource(session.source)) continue
      const externalId = (session.user_id || '').trim()
      if (!externalId) continue
      const key = `${session.source}:${externalId}`
      const entry = counts.get(key)
      if (entry) entry.session_count += 1
      else counts.set(key, { source: String(session.source), external_id: externalId, session_count: 1 })
    }
    return [...counts.values()].sort((a, b) => b.session_count - a.session_count)
  } catch {
    // Preserve the empty candidate list when Hermes history is unavailable.
    return []
  }
}

export function createMapping(body: ExternalIdentityInput | undefined) {
  const source = String(body?.source || '').trim()
  const externalId = String(body?.external_id || '').trim()
  const userId = Number(body?.user_id)
  if (!isChannelSource(source)) {
    throw new ExternalIdentityError('source must be one of feishu/dingtalk/weixin/wecom/webhook', 'invalid')
  }
  if (!externalId) throw new ExternalIdentityError('external_id is required', 'invalid')
  if (!Number.isInteger(userId) || userId <= 0 || !findUserById(userId)) {
    throw new ExternalIdentityError('user_id must reference an existing user', 'invalid')
  }
  const result = createExternalIdentity({
    source, externalId, userId,
    note: typeof body?.note === 'string' ? body.note.slice(0, 200) : undefined,
  })
  if (result == null) throw new ExternalIdentityError('Invalid mapping', 'invalid')
  if ('conflict' in result) {
    throw new ExternalIdentityError('A mapping for this source and external_id already exists', 'conflict')
  }
  return { ...result, username: findUserById(userId)?.username || null }
}

export function listMappingUsers() {
  return listUsers()
    .filter(user => user.status === 'active')
    .map(user => ({ id: user.id, username: user.username }))
}

export function removeMapping(id: number): void {
  if (!Number.isInteger(id) || id <= 0) throw new ExternalIdentityError('Invalid mapping id', 'invalid')
  if (!deleteExternalIdentity(id)) throw new ExternalIdentityError('Mapping not found', 'not_found')
}
