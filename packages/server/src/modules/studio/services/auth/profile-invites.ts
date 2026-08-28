import {
  createProfileInvite,
  findProfileInviteByCode,
  getInviteStatus,
  listProfileInvites,
  recordProfileInviteUse,
  revokeProfileInvite,
  type ProfileInviteRecord,
  type ProfileInviteSummary,
} from '../../repositories/profile-invites-store'
import { listProfileNamesFromDisk } from '../../public/profile-config'

export const DEFAULT_INVITE_EXPIRES_DAYS = 7

export type InviteValidation = { ok: true; invite: ProfileInviteRecord } | { ok: false; reason: 'not_found' | 'revoked' | 'expired' }

export function validateProfileName(profileName: string): boolean {
  const normalized = profileName.trim()
  if (!normalized) return false
  return listProfileNamesFromDisk().includes(normalized)
}

export function createInvite(input: {
  profileName: string
  createdByUserId: number
  expiresInDays?: number
  maxUses?: number
}): { ok: true; invite: ProfileInviteRecord } | { ok: false; error: string } {
  const profileName = input.profileName.trim()
  if (!validateProfileName(profileName)) {
    return { ok: false, error: `Profile "${profileName}" does not exist` }
  }
  const expiresInDays = input.expiresInDays ?? DEFAULT_INVITE_EXPIRES_DAYS
  if (!Number.isFinite(expiresInDays) || expiresInDays < 0 || expiresInDays > 365) {
    return { ok: false, error: 'expiresInDays must be between 0 and 365' }
  }
  const maxUses = input.maxUses ?? 0
  if (!Number.isFinite(maxUses) || maxUses < 0 || !Number.isInteger(maxUses)) {
    return { ok: false, error: 'maxUses must be a non-negative integer' }
  }
  const expiresAt = expiresInDays > 0 ? Date.now() + expiresInDays * 86400_000 : null
  const invite = createProfileInvite({
    profileName,
    createdByUserId: input.createdByUserId,
    maxUses,
    expiresAt,
  })
  if (!invite) return { ok: false, error: 'Failed to persist invite' }
  return { ok: true, invite }
}

export function getInviteByCode(code: string): ProfileInviteSummary | null {
  const invite = findProfileInviteByCode(code)
  return invite ? { ...invite, status: getInviteStatus(invite) } : null
}

export function listInvites(): ProfileInviteSummary[] {
  return listProfileInvites()
}

export function revokeInvite(code: string): boolean {
  return revokeProfileInvite(code)
}

export function validateInviteForUse(code: string): InviteValidation {
  const invite = findProfileInviteByCode(code)
  if (!invite) return { ok: false, reason: 'not_found' }
  const status = getInviteStatus(invite)
  if (status === 'revoked') return { ok: false, reason: 'revoked' }
  if (status === 'expired') return { ok: false, reason: 'expired' }
  return { ok: true, invite }
}

export function consumeInviteUse(code: string): void {
  recordProfileInviteUse(code)
}
