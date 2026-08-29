import { getDb } from '../infrastructure/database'
import { EXTERNAL_IDENTITIES_TABLE } from '../infrastructure/database/schemas'

/**
 * External channel identity -> Studio user mapping (feishu open_id, dingtalk
 * user string, ...). Channel sessions never get an owner; this mapping
 * decides who may READ the channel history as their own (read-only).
 */
export interface ExternalIdentityRecord {
  id: number
  source: string
  external_id: string
  user_id: number
  note: string
  created_at: number
  updated_at: number
}

const CHANNEL_SOURCES = ['feishu', 'dingtalk', 'weixin', 'wecom', 'webhook']

export function isChannelSource(source: string | null | undefined): boolean {
  return CHANNEL_SOURCES.includes(String(source || '').toLowerCase())
}

export function listExternalIdentities(): ExternalIdentityRecord[] {
  const db = getDb()
  if (!db) return []
  return db.prepare(
    `SELECT * FROM ${EXTERNAL_IDENTITIES_TABLE} ORDER BY created_at DESC`,
  ).all() as unknown as ExternalIdentityRecord[]
}

export function createExternalIdentity(input: {
  source: string
  externalId: string
  userId: number
  note?: string
}): ExternalIdentityRecord | { conflict: true } | null {
  const db = getDb()
  if (!db) return null
  const source = input.source.trim().toLowerCase()
  const externalId = input.externalId.trim()
  if (!isChannelSource(source) || !externalId || !Number.isFinite(input.userId)) return null
  const now = Date.now()
  try {
    db.prepare(
      `INSERT INTO ${EXTERNAL_IDENTITIES_TABLE} (source, external_id, user_id, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(source, externalId, input.userId, input.note || '', now, now)
  } catch (err: any) {
    if (String(err?.message || '').includes('UNIQUE')) return { conflict: true }
    throw err
  }
  return findExternalIdentity(source, externalId)
}

export function findExternalIdentity(source: string, externalId: string): ExternalIdentityRecord | null {
  const db = getDb()
  if (!db) return null
  const row = db.prepare(
    `SELECT * FROM ${EXTERNAL_IDENTITIES_TABLE} WHERE source = ? AND external_id = ?`,
  ).get(String(source).toLowerCase(), externalId) as ExternalIdentityRecord | undefined
  return row || null
}

/** Resolve the Studio user id a channel actor maps to, or null. */
export function findMappedUserId(source: string, externalId: string): number | null {
  const record = findExternalIdentity(source, externalId)
  return record ? record.user_id : null
}

export function deleteExternalIdentity(id: number): boolean {
  const db = getDb()
  if (!db) return false
  const result = db.prepare(`DELETE FROM ${EXTERNAL_IDENTITIES_TABLE} WHERE id = ?`).run(id)
  return result.changes > 0
}
