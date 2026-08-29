import { getDb } from '../../../studio/infrastructure/database'
import { MARKETPLACE_SOURCES_TABLE } from '../../../studio/infrastructure/database/schemas'

/**
 * Configured marketplace source registry. Stored in the Studio database
 * (management domain): the catalog itself lives in each source's git cache,
 * never in here — rows only hold identity + last-sync bookkeeping.
 */

export interface MarketplaceSourceRecord {
  id: number
  name: string
  url: string
  enabled: number
  created_at: number
  updated_at: number
  last_synced_at: number | null
  last_commit: string | null
  last_error: string | null
}

export function listMarketplaceSources(): MarketplaceSourceRecord[] | null {
  const db = getDb()
  if (!db) return null
  return db.prepare(
    `SELECT * FROM ${MARKETPLACE_SOURCES_TABLE} ORDER BY created_at ASC, id ASC`,
  ).all() as unknown as MarketplaceSourceRecord[]
}

export function findMarketplaceSource(id: number): MarketplaceSourceRecord | null {
  const db = getDb()
  if (!db) return null
  const row = db.prepare(
    `SELECT * FROM ${MARKETPLACE_SOURCES_TABLE} WHERE id = ?`,
  ).get(id) as MarketplaceSourceRecord | undefined
  return row || null
}

export interface CreateMarketplaceSourceInput {
  name: string
  url: string
}

export class MarketplaceSourceValidationError extends Error {}
export class MarketplaceSourceConflictError extends Error {}

export function createMarketplaceSource(input: CreateMarketplaceSourceInput): MarketplaceSourceRecord | { conflict: true } | null {
  const db = getDb()
  if (!db) return null
  const name = String(input.name || '').trim()
  const url = String(input.url || '').trim()
  if (!name) throw new MarketplaceSourceValidationError('Source name is required')
  if (name.length > 120) throw new MarketplaceSourceValidationError('Source name must be 120 characters or fewer')
  if (!url) throw new MarketplaceSourceValidationError('Source URL is required')

  const now = Date.now()
  try {
    db.prepare(
      `INSERT INTO ${MARKETPLACE_SOURCES_TABLE} (name, url, enabled, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?)`,
    ).run(name, url, now, now)
  } catch (err: any) {
    if (String(err?.message || '').includes('UNIQUE')) return { conflict: true }
    throw err
  }
  const id = Number((db.prepare('SELECT last_insert_rowid() AS id').get() as any)?.id)
  return findMarketplaceSource(id)
}

export function updateMarketplaceSource(
  id: number,
  patch: { name?: string; enabled?: boolean },
): MarketplaceSourceRecord | null {
  const db = getDb()
  if (!db) return null
  const existing = findMarketplaceSource(id)
  if (!existing) return null
  const name = patch.name !== undefined ? String(patch.name).trim() : existing.name
  const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled
  if (!name) throw new MarketplaceSourceValidationError('Source name is required')
  if (name.length > 120) throw new MarketplaceSourceValidationError('Source name must be 120 characters or fewer')
  db.prepare(
    `UPDATE ${MARKETPLACE_SOURCES_TABLE} SET name = ?, enabled = ?, updated_at = ? WHERE id = ?`,
  ).run(name, enabled, Date.now(), id)
  return findMarketplaceSource(id)
}

export function deleteMarketplaceSource(id: number): boolean {
  const db = getDb()
  if (!db) return false
  const result = db.prepare(`DELETE FROM ${MARKETPLACE_SOURCES_TABLE} WHERE id = ?`).run(id)
  return result.changes > 0
}

export function recordSourceSync(
  id: number,
  result: { commit?: string; error?: string },
): void {
  const db = getDb()
  if (!db) return
  const now = Date.now()
  const commit = result.commit ?? null
  const error = result.error ? String(result.error).slice(0, 500) : null
  db.prepare(
    `UPDATE ${MARKETPLACE_SOURCES_TABLE}
     SET last_synced_at = ?, last_commit = COALESCE(?, last_commit), last_error = ?, updated_at = ?
     WHERE id = ?`,
  ).run(now, commit, error, now, id)
}
