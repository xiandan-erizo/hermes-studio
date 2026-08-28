import { randomBytes } from 'crypto'
import { getDb } from '../infrastructure/database'
import { PROFILE_INVITES_TABLE } from '../infrastructure/database/schemas'

export type ProfileInviteStatus = 'active' | 'revoked' | 'expired'

export interface ProfileInviteRecord {
  id: number
  code: string
  profile_name: string
  created_by_user_id: number
  use_count: number
  max_uses: number
  expires_at: number | null
  revoked_at: number | null
  created_at: number
  updated_at: number
}

export interface ProfileInviteSummary extends ProfileInviteRecord {
  status: ProfileInviteStatus
}

const CODE_BYTES = 24

export function generateInviteCode(): string {
  return randomBytes(CODE_BYTES).toString('base64url')
}

function toSummary(record: ProfileInviteRecord): ProfileInviteSummary {
  return {
    ...record,
    status: getInviteStatus(record),
  }
}

export function getInviteStatus(invite: Pick<ProfileInviteRecord, 'revoked_at' | 'expires_at' | 'max_uses' | 'use_count'>, now = Date.now()): ProfileInviteStatus {
  if (invite.revoked_at) return 'revoked'
  if (invite.expires_at && invite.expires_at <= now) return 'expired'
  if (invite.max_uses > 0 && invite.use_count >= invite.max_uses) return 'expired'
  return 'active'
}

export function createProfileInvite(input: {
  profileName: string
  createdByUserId: number
  maxUses?: number
  expiresAt?: number | null
  code?: string
}): ProfileInviteRecord | null {
  const db = getDb()
  if (!db) return null
  const now = Date.now()
  const code = input.code || generateInviteCode()
  db.prepare(
    `INSERT INTO ${PROFILE_INVITES_TABLE} (code, profile_name, created_by_user_id, use_count, max_uses, expires_at, revoked_at, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?, NULL, ?, ?)`
  ).run(code, input.profileName, input.createdByUserId, input.maxUses || 0, input.expiresAt ?? null, now, now)
  return findProfileInviteByCode(code)
}

export function findProfileInviteByCode(code: string): ProfileInviteRecord | null {
  const db = getDb()
  if (!db) return null
  const row = db.prepare(
    `SELECT * FROM ${PROFILE_INVITES_TABLE} WHERE code = ?`
  ).get(code) as ProfileInviteRecord | undefined
  return row || null
}

export function listProfileInvites(): ProfileInviteSummary[] {
  const db = getDb()
  if (!db) return []
  const rows = db.prepare(
    `SELECT * FROM ${PROFILE_INVITES_TABLE} ORDER BY created_at DESC`
  ).all() as unknown as ProfileInviteRecord[]
  return rows.map(toSummary)
}

export function revokeProfileInvite(code: string): boolean {
  const db = getDb()
  if (!db) return false
  const result = db.prepare(
    `UPDATE ${PROFILE_INVITES_TABLE} SET revoked_at = ?, updated_at = ? WHERE code = ? AND revoked_at IS NULL`
  ).run(Date.now(), Date.now(), code)
  return result.changes > 0
}

export function deleteProfileInvite(code: string): boolean {
  const db = getDb()
  if (!db) return false
  const result = db.prepare(`DELETE FROM ${PROFILE_INVITES_TABLE} WHERE code = ?`).run(code)
  return result.changes > 0
}

export function recordProfileInviteUse(code: string): void {
  const db = getDb()
  if (!db) return
  db.prepare(
    `UPDATE ${PROFILE_INVITES_TABLE} SET use_count = use_count + 1, updated_at = ? WHERE code = ?`
  ).run(Date.now(), code)
}
