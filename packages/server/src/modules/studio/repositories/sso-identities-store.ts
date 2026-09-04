import { getDb } from '../infrastructure/database'
import { SSO_IDENTITIES_TABLE } from '../infrastructure/database/schemas'

export type SsoProvider = 'oidc'

export interface SsoIdentityRecord {
  id: number
  provider: SsoProvider
  subject: string
  username: string
  display_name: string
  email: string
  user_id: number
  created_at: number
  updated_at: number
}

export function findSsoIdentity(provider: SsoProvider, subject: string): SsoIdentityRecord | null {
  const db = getDb()
  if (!db) return null
  const row = db.prepare(
    `SELECT * FROM ${SSO_IDENTITIES_TABLE} WHERE provider = ? AND subject = ?`
  ).get(provider, subject) as SsoIdentityRecord | undefined
  return row || null
}

export function findSsoIdentityByUserId(userId: number): SsoIdentityRecord | null {
  const db = getDb()
  if (!db) return null
  const row = db.prepare(
    `SELECT * FROM ${SSO_IDENTITIES_TABLE} WHERE user_id = ? ORDER BY id LIMIT 1`
  ).get(userId) as SsoIdentityRecord | undefined
  return row || null
}

export function createSsoIdentity(input: {
  provider: SsoProvider
  subject: string
  username?: string
  displayName?: string
  email?: string
  userId: number
}): SsoIdentityRecord | null {
  const db = getDb()
  if (!db) return null
  const now = Date.now()
  db.prepare(
    `INSERT INTO ${SSO_IDENTITIES_TABLE} (provider, subject, username, display_name, email, user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(input.provider, input.subject, input.username || '', input.displayName || '', input.email || '', input.userId, now, now)
  return findSsoIdentity(input.provider, input.subject)
}

export function updateSsoIdentityProfile(input: {
  id: number
  username?: string
  displayName?: string
  email?: string
}): boolean {
  const db = getDb()
  if (!db) return false
  const now = Date.now()
  const result = db.prepare(
    `UPDATE ${SSO_IDENTITIES_TABLE}
     SET username = COALESCE(?, username), display_name = COALESCE(?, display_name), email = COALESCE(?, email), updated_at = ?
     WHERE id = ?`
  ).run(input.username ?? null, input.displayName ?? null, input.email ?? null, now, input.id)
  return result.changes > 0
}
