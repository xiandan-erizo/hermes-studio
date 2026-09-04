import type {
  PersonalChatIdentityPolicyContext,
  PersonalChatIdentityPolicyOrigin,
  PersonalChatIdentitySnapshot,
} from '../../contracts/runs/session'
import type { AuthenticatedUser } from '../../public/auth'
import { findSsoIdentityByUserId } from '../../repositories/sso-identities-store'

export type {
  PersonalChatIdentityPolicyContext,
  PersonalChatIdentitySnapshot,
} from '../../contracts/runs/session'

export class PersonalChatIdentityResolutionError extends Error {
  constructor() {
    super('SSO account email is required for personal chat')
    this.name = 'PersonalChatIdentityResolutionError'
  }
}

export function resolvePersonalChatIdentity(
  user: AuthenticatedUser | undefined,
): PersonalChatIdentitySnapshot | undefined {
  if (!user) return undefined

  const identity = findSsoIdentityByUserId(user.id)
  const email = identity?.email.trim().toLowerCase() || ''
  if (!email) {
    if (user.role === 'user') throw new PersonalChatIdentityResolutionError()
    return undefined
  }

  return {
    version: 1,
    source: 'hermes_studio',
    email,
    ...(identity?.username ? { username: identity.username } : {}),
    ...(identity?.display_name ? { displayName: identity.display_name } : {}),
  }
}

export function resolvePersonalChatIdentityPolicy(
  origin: PersonalChatIdentityPolicyOrigin,
  user: AuthenticatedUser | undefined,
): PersonalChatIdentityPolicyContext {
  return {
    origin,
    ...(origin === 'cli'
      ? { personalChatIdentity: resolvePersonalChatIdentity(user) }
      : {}),
  }
}
