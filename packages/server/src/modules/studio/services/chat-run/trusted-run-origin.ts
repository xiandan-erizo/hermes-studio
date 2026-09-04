import { randomBytes, timingSafeEqual } from 'crypto'
import type { PersonalChatIdentityPolicyOrigin } from '../../contracts/runs/session'

type TrustedSocketOrigin = Extract<PersonalChatIdentityPolicyOrigin, 'global_agent'>

const originCapability = randomBytes(32).toString('base64url')
const ORIGIN_FIELD = '__studio_chat_run_origin'
const CAPABILITY_FIELD = '__studio_chat_run_origin_capability'

export function createTrustedChatRunSocketAuth(origin: TrustedSocketOrigin): Record<string, string> {
  return {
    [ORIGIN_FIELD]: origin,
    [CAPABILITY_FIELD]: originCapability,
  }
}

export function resolveTrustedChatRunSocketOrigin(auth: unknown): TrustedSocketOrigin | undefined {
  if (!auth || typeof auth !== 'object') return undefined
  const value = auth as Record<string, unknown>
  if (value[ORIGIN_FIELD] !== 'global_agent' || typeof value[CAPABILITY_FIELD] !== 'string') return undefined
  const actual = Buffer.from(value[CAPABILITY_FIELD])
  const expected = Buffer.from(originCapability)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
    ? 'global_agent'
    : undefined
}
