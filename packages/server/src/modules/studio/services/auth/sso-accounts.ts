import { randomBytes } from 'crypto'
import { findUserById, findUserByUsername, createUser, type UserRecord } from '../../public/users'
import {
  createSsoIdentity,
  findSsoIdentity,
  findSsoIdentityByUserId,
  updateSsoIdentityProfile,
  type SsoIdentityRecord,
} from '../../repositories/sso-identities-store'

export interface SsoAccountClaims {
  sub: string
  username: string
  displayName: string
  email: string
}

export function findSsoAccountByUserId(userId: number): SsoIdentityRecord | null {
  return findSsoIdentityByUserId(userId)
}

function deriveUsername(base: string): string {
  const normalized = base.replace(/[^a-zA-Z0-9_.-]/g, '_').replace(/^_+|_+$/g, '').slice(0, 60)
  return normalized.length >= 2 ? normalized : `sso_${randomBytes(4).toString('hex')}`
}

function uniqueUsername(base: string): string {
  const username = deriveUsername(base)
  if (!findUserByUsername(username)) return username
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const next = `${username}_${attempt}`
    if (!findUserByUsername(next)) return next
  }
  return `sso_${randomBytes(6).toString('hex')}`
}

/**
 * Resolve an external OIDC identity to a local account. First-time identities
 * are provisioned as role 'user' with a random (unused) password so the
 * account can only sign in through SSO.
 */
export function resolveSsoAccount(claims: SsoAccountClaims): { user: UserRecord; identity: SsoIdentityRecord } | null {
  const existing = findSsoIdentity('oidc', claims.sub)
  if (existing) {
    const user = findUserById(existing.user_id)
    if (user) {
      updateSsoIdentityProfile({
        id: existing.id,
        username: claims.username,
        displayName: claims.displayName,
        email: claims.email,
      })
      const identity = findSsoIdentity('oidc', claims.sub)
      return identity ? { user, identity } : null
    }
    return null
  }

  const username = uniqueUsername(claims.username || claims.email || claims.sub)
  const user = createUser({
    username,
    password: randomBytes(32).toString('hex'),
    role: 'user',
    status: 'active',
    profiles: [],
    defaultProfile: null,
  })
  if (!user) return null
  const identity = createSsoIdentity({
    provider: 'oidc',
    subject: claims.sub,
    username: claims.username,
    displayName: claims.displayName,
    email: claims.email,
    userId: user.id,
  })
  if (!identity) return null
  return { user, identity }
}
