import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

const originalEnv = process.env
const originalFetch = globalThis.fetch

function signedIdToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const signedContent = `${header}.${payload}`
  const signature = createHash('sha256').update('client-secret').update(signedContent).digest('base64url')
  return `${signedContent}.${signature}`
}

describe('OIDC identity claims', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env = {
      ...originalEnv,
      HERMES_SSO_ISSUER: 'https://sso.example.test',
      HERMES_SSO_CLIENT_ID: 'client-id',
      HERMES_SSO_CLIENT_SECRET: 'client-secret',
    }
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    process.env = { ...originalEnv }
    vi.resetModules()
  })

  afterAll(() => {
    process.env = originalEnv
    globalThis.fetch = originalFetch
  })

  function mockOidcResponses(userInfo: Record<string, unknown>) {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/.well-known/openid-configuration')) {
        return new Response(JSON.stringify({
          issuer: 'https://sso.example.test',
          authorization_endpoint: 'https://sso.example.test/authorize',
          token_endpoint: 'https://sso.example.test/token',
          userinfo_endpoint: 'https://sso.example.test/userinfo',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url === 'https://sso.example.test/userinfo') {
        return new Response(JSON.stringify(userInfo), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`Unexpected OIDC request: ${url}`)
    }) as typeof fetch
  }

  it('merges matching UserInfo profile fields into verified ID token claims', async () => {
    mockOidcResponses({ sub: 'subject-1', name: 'Bob Example', email: 'Bob@Example.com' })
    const oidc = await import('../../packages/server/src/modules/studio/services/auth/oidc')

    await expect(oidc.resolveOidcIdentityClaims({
      idToken: signedIdToken({
        iss: 'https://sso.example.test',
        aud: 'client-id',
        exp: Math.floor(Date.now() / 1000) + 60,
        nonce: 'nonce-1',
        sub: 'subject-1',
        preferred_username: 'bob',
      }),
      accessToken: 'access-token',
    }, 'nonce-1')).resolves.toEqual({
      sub: 'subject-1',
      username: 'bob',
      displayName: 'Bob Example',
      email: 'Bob@Example.com',
    })
  })

  it('rejects a successful UserInfo response for another subject', async () => {
    mockOidcResponses({ sub: 'subject-2', name: 'Bob Example', email: 'bob@example.com' })
    const oidc = await import('../../packages/server/src/modules/studio/services/auth/oidc')

    await expect(oidc.resolveOidcIdentityClaims({
      idToken: signedIdToken({
        iss: 'https://sso.example.test',
        aud: 'client-id',
        exp: Math.floor(Date.now() / 1000) + 60,
        nonce: 'nonce-2',
        sub: 'subject-1',
        preferred_username: 'bob',
      }),
      accessToken: 'access-token',
    }, 'nonce-2')).rejects.toThrow('OIDC userinfo subject mismatch')
  })

  it('does not collapse whitespace-bearing subjects when matching UserInfo', async () => {
    mockOidcResponses({ sub: 'subject-1', name: 'Bob Example', email: 'bob@example.com' })
    const oidc = await import('../../packages/server/src/modules/studio/services/auth/oidc')

    await expect(oidc.resolveOidcIdentityClaims({
      idToken: signedIdToken({
        iss: 'https://sso.example.test',
        aud: 'client-id',
        exp: Math.floor(Date.now() / 1000) + 60,
        nonce: 'nonce-3',
        sub: ' subject-1 ',
        preferred_username: 'bob',
      }),
      accessToken: 'access-token',
    }, 'nonce-3')).rejects.toThrow('OIDC userinfo subject mismatch')
  })
})
