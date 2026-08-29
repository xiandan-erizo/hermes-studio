/**
 * Session ownership data domain (P0).
 *
 * Legacy `sessions.user_id` is semantically mixed: it may hold a Studio user
 * id, an external channel actor id (feishu open_id, dingtalk LWCP string, ...)
 * or be NULL. This module splits that into explicit concepts:
 *
 *   owner_user_id          Studio authorization subject (can operate)
 *   external_actor_source  'feishu' | 'dingtalk' | 'weixin' | ...
 *   external_actor_id      the raw external identity
 *   origin_source/origin_session_id  provenance for imported sessions
 *
 * Migration is versioned, idempotent and replay-safe:
 *   - only rows with ownership_migration_version < CURRENT migrate
 *   - rows already 'owned' (e.g. admin-claimed) are never overwritten
 *   - 'unresolved' rows are never auto-claimed by re-runs
 *
 * IMPORTANT: source='cli' alone does NOT prove Studio ownership (history
 * imports also persist as 'cli'). Only the explicit verified mapping below
 * and creation-time writes set owners.
 */

export const SESSION_OWNERSHIP_MIGRATION_VERSION = 1
export const SESSION_OWNERSHIP_MIGRATION_ID = 'session-ownership-v1'

/** Explicitly verified legacy mappings (session id -> Studio user id).
 *  Populated from manual verification of the dev / prod databases.
 *  Format: { [sessionRowId]: ownerId } keyed by session id. */
const VERIFIED_OWNER_MAPPINGS: Record<string, number> = {
  // dev machine (packages/server/data/hermes-web-ui.db), verified 2026-08-29
  'mt762614one9sv': 1, // admin
  'mt7d47641e9ti4': 2, // alice
  'mt86zv26m066ek': 3, // sunkesi@hosecloud.com
  'mtctx6jpew6v01': 1, // admin
}

/** Channel sources whose sessions have external actors (owner stays NULL). */
const EXTERNAL_SOURCES = new Set(['feishu', 'dingtalk', 'weixin', 'wecom', 'webhook'])

export type OwnershipState = 'owned' | 'external' | 'unresolved'
export type OwnershipResolution = 'created' | 'migration_verified' | 'imported' | 'admin_claimed'

export interface OwnershipClassification {
  state: OwnershipState
  externalActorSource?: string | null
  externalActorId?: string | null
  verifiedOwnerUserId?: number | null
}

/** Pure, read-only classifier for one legacy session row. */
export function classifyLegacySession(row: {
  id: string
  source?: string | null
  user_id?: string | number | null
}): OwnershipClassification {
  const source = String(row.source || '').toLowerCase()
  const rawUserId = row.user_id == null ? '' : String(row.user_id).trim()

  if (VERIFIED_OWNER_MAPPINGS[row.id] != null) {
    return { state: 'owned', verifiedOwnerUserId: VERIFIED_OWNER_MAPPINGS[row.id] }
  }
  if (EXTERNAL_SOURCES.has(source)) {
    return {
      state: 'external',
      externalActorSource: source,
      externalActorId: rawUserId || null,
    }
  }
  // Deliberately conservative: a numeric user_id that happens to match a
  // users.id is NOT auto-claimed (external actor ids can collide).
  return { state: 'unresolved' }
}

export interface OwnershipMigrationSummary {
  migrated: number
  owned: number
  external: number
  unresolved: number
  skippedAlreadyOwned: number
}

/** Structural subset of DatabaseSync used by this module (tests can stub it). */
/* eslint-disable @typescript-eslint/no-explicit-any */
export type MinimalDb = {
  prepare: (sql: string) => {
    run: (...args: any[]) => { changes: number | bigint }
    all: (...args: any[]) => any[]
    get: (...args: any[]) => any
  }
  exec: (sql: string) => void
}

function readLedger(db: MinimalDb): number {
  const row = db.prepare(
    `SELECT result_summary FROM schema_migrations WHERE migration_id = ?`,
  ).get(SESSION_OWNERSHIP_MIGRATION_ID) as { result_summary?: string } | undefined
  if (!row?.result_summary) return 0
  try { return Number(JSON.parse(row.result_summary).version || 0) } catch { return 0 }
}

function writeLedger(db: MinimalDb, summary: OwnershipMigrationSummary): void {
  const now = Math.floor(Date.now() / 1000)
  const payload = JSON.stringify({ ...summary, version: SESSION_OWNERSHIP_MIGRATION_VERSION })
  db.exec('BEGIN')
  try {
    db.prepare(
      `INSERT INTO schema_migrations (migration_id, applied_at, result_summary) VALUES (?, ?, ?)
       ON CONFLICT(migration_id) DO UPDATE SET applied_at = excluded.applied_at, result_summary = excluded.result_summary`,
    ).run(SESSION_OWNERSHIP_MIGRATION_ID, now, payload)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/** Versioned, idempotent, replay-safe ownership backfill. */
export function migrateSessionOwnership(db: MinimalDb): OwnershipMigrationSummary {
  const summary: OwnershipMigrationSummary = {
    migrated: 0, owned: 0, external: 0, unresolved: 0, skippedAlreadyOwned: 0,
  }
  if (readLedger(db) >= SESSION_OWNERSHIP_MIGRATION_VERSION) return summary

  const rows = db.prepare(
    `SELECT id, source, user_id, owner_user_id, ownership_state FROM sessions
     WHERE ownership_migration_version IS NULL OR ownership_migration_version < ?`,
  ).all(SESSION_OWNERSHIP_MIGRATION_VERSION) as Array<{
    id: string
    source: string | null
    user_id: string | null
    owner_user_id: number | null
    ownership_state: string | null
  }>

  db.exec('BEGIN')
  try {
    for (const row of rows) {
      // Never overwrite an existing owner (e.g. manually claimed, or created
      // with an owner by new code).
      if (row.ownership_state === 'owned' || row.owner_user_id != null) {
        db.prepare(
          `UPDATE sessions SET ownership_migration_version = ? WHERE id = ?`,
        ).run(SESSION_OWNERSHIP_MIGRATION_VERSION, row.id)
        summary.skippedAlreadyOwned += 1
        continue
      }

      const verdict = classifyLegacySession(row)
      if (verdict.state === 'owned') {
        db.prepare(
          `UPDATE sessions SET owner_user_id = ?, ownership_state = 'owned',
             ownership_resolution = 'migration_verified', ownership_migration_version = ?
           WHERE id = ?`,
        ).run(verdict.verifiedOwnerUserId ?? null, SESSION_OWNERSHIP_MIGRATION_VERSION, row.id)
        summary.owned += 1
      } else if (verdict.state === 'external') {
        db.prepare(
          `UPDATE sessions SET external_actor_source = ?, external_actor_id = ?,
             ownership_state = 'external', ownership_migration_version = ?
           WHERE id = ?`,
        ).run(verdict.externalActorSource ?? null, verdict.externalActorId ?? null,
          SESSION_OWNERSHIP_MIGRATION_VERSION, row.id)
        summary.external += 1
      } else {
        db.prepare(
          `UPDATE sessions SET ownership_state = 'unresolved', ownership_migration_version = ?
           WHERE id = ?`,
        ).run(SESSION_OWNERSHIP_MIGRATION_VERSION, row.id)
        summary.unresolved += 1
      }
      summary.migrated += 1
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  writeLedger(db, summary)
  return summary
}

/** Read-only dry-run report (no writes). */
export interface DryRunReport {
  total: number
  owned: number
  external: number
  unresolved: number
  notMigrated: number
  suspiciousNumericCollisions: Array<{ id: string; user_id: string }>
}

export function dryRunOwnershipClassification(db: MinimalDb): DryRunReport {
  const rows = db.prepare(
    `SELECT id, source, user_id, ownership_state, ownership_migration_version FROM sessions`,
  ).all() as Array<{
    id: string
    source: string | null
    user_id: string | null
    ownership_state: string | null
    ownership_migration_version: number | null
  }>
  const report: DryRunReport = {
    total: rows.length, owned: 0, external: 0, unresolved: 0, notMigrated: 0,
    suspiciousNumericCollisions: [],
  }
  for (const row of rows) {
    if (row.ownership_migration_version == null || row.ownership_migration_version < SESSION_OWNERSHIP_MIGRATION_VERSION) {
      if (row.ownership_state !== 'owned') { report.notMigrated += 1 }
    }
    const state = row.ownership_state || classifyLegacySession(row).state
    if (state === 'owned') report.owned += 1
    else if (state === 'external') report.external += 1
    else report.unresolved += 1

    const raw = (row.user_id || '').trim()
    if (/^\d+$/.test(raw) && !VERIFIED_OWNER_MAPPINGS[row.id]) {
      report.suspiciousNumericCollisions.push({ id: row.id, user_id: raw })
    }
  }
  return report
}
