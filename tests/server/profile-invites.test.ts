import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('Profile invites', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
    }))
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.resetModules()
  })

  async function loadStore() {
    return await import('../../packages/server/src/modules/studio/repositories/profile-invites-store')
  }

  it('creates multi-use invites and tracks usage', async () => {
    const store = await loadStore()
    const invite = store.createProfileInvite({
      profileName: 'default',
      createdByUserId: 1,
      maxUses: 0,
      expiresAt: Date.now() + 60_000,
    })

    expect(invite).not.toBeNull()
    expect(invite!.profile_name).toBe('default')
    expect(invite!.use_count).toBe(0)

    store.recordProfileInviteUse(invite!.code)
    store.recordProfileInviteUse(invite!.code)
    const reloaded = store.findProfileInviteByCode(invite!.code)
    expect(reloaded!.use_count).toBe(2)
    expect(store.getInviteStatus(reloaded!)).toBe('active')
  })

  it('expires invites past their expiry or use limit', async () => {
    const store = await loadStore()
    const expired = store.createProfileInvite({
      profileName: 'default',
      createdByUserId: 1,
      maxUses: 0,
      expiresAt: Date.now() - 1,
    })
    expect(store.getInviteStatus(expired!)).toBe('expired')

    const limited = store.createProfileInvite({
      profileName: 'default',
      createdByUserId: 1,
      maxUses: 1,
      expiresAt: null,
    })
    store.recordProfileInviteUse(limited!.code)
    expect(store.getInviteStatus(store.findProfileInviteByCode(limited!.code)!)).toBe('expired')
  })

  it('revokes invites exactly once', async () => {
    const store = await loadStore()
    const invite = store.createProfileInvite({
      profileName: 'default',
      createdByUserId: 3,
      expiresAt: null,
    })

    expect(store.revokeProfileInvite(invite!.code)).toBe(true)
    expect(store.getInviteStatus(store.findProfileInviteByCode(invite!.code)!)).toBe('revoked')
    expect(store.revokeProfileInvite(invite!.code)).toBe(false)
  })

  it('appends profile bindings without wiping existing ones', async () => {
    const users = await import('../../packages/server/src/modules/studio/repositories/users-store')
    const user = users.createUser({
      username: 'alice',
      password: 'secret1',
      role: 'user',
      profiles: ['default'],
      defaultProfile: 'default',
    })

    expect(users.addUserProfileBinding(user!.id, 'work')).toBe(true)
    expect(users.userCanAccessProfile(user!.id, 'work')).toBe(true)
    expect(users.userCanAccessProfile(user!.id, 'default')).toBe(true)
    expect(users.listUserProfiles(user!.id).map(profile => profile.profile_name).sort())
      .toEqual(['default', 'work'])

    // idempotent
    expect(users.addUserProfileBinding(user!.id, 'work')).toBe(true)
    expect(users.listUserProfiles(user!.id)).toHaveLength(2)
  })

  it('maps SSO identities to local user accounts', async () => {
    const users = await import('../../packages/server/src/modules/studio/repositories/users-store')
    const identities = await import('../../packages/server/src/modules/studio/repositories/sso-identities-store')
    const user = users.createUser({
      username: 'sso_bob',
      password: 'randompass',
      role: 'user',
      profiles: [],
    })

    const identity = identities.createSsoIdentity({
      provider: 'oidc',
      subject: 'subject-1',
      username: 'bob',
      displayName: 'Bob Example',
      email: 'bob@example.com',
      userId: user!.id,
    })

    expect(identity).not.toBeNull()
    expect(identity!.display_name).toBe('Bob Example')
    const found = identities.findSsoIdentity('oidc', 'subject-1')
    expect(found!.user_id).toBe(user!.id)
    expect(identities.findSsoIdentity('oidc', 'other')).toBeNull()
    expect(identities.findSsoIdentityByUserId(user!.id)?.email).toBe('bob@example.com')

    identities.updateSsoIdentityProfile({ id: identity!.id, displayName: 'Robert Example', email: 'bob2@example.com' })
    expect(identities.findSsoIdentity('oidc', 'subject-1')!.email).toBe('bob2@example.com')
    expect(identities.findSsoIdentity('oidc', 'subject-1')!.display_name).toBe('Robert Example')
  })
})

describe('requireElevatedApi role gate', () => {
  const loadMiddleware = () => import('../../packages/server/src/modules/studio/middleware/auth')

  function ctx(path: string, role?: string, method = 'GET') {
    const context: any = {
      path,
      method,
      status: 0,
      body: null,
      state: role ? { user: { id: 1, username: 'u', role } } : {},
      next: async () => { context.status = 200 },
    }
    return context
  }

  it('blocks the plain user role on /api management paths', async () => {
    const { requireElevatedApi } = await loadMiddleware()
    const context = ctx('/api/hermes/models', 'user')
    await requireElevatedApi(context, context.next)
    expect(context.status).toBe(403)
  })

  it('lets the user role read chat-facing endpoints but not write them', async () => {
    const { requireElevatedApi } = await loadMiddleware()
    for (const path of ['/api/hermes/profiles', '/api/hermes/available-models', '/api/hermes/config']) {
      const read = ctx(path, 'user', 'GET')
      await requireElevatedApi(read, read.next)
      expect(read.status).toBe(200)
      const write = ctx('/api/hermes/config', 'user', 'PUT')
      await requireElevatedApi(write, write.next)
      expect(write.status).toBe(403)
    }
  })

  it('allows admin and super_admin on /api paths', async () => {
    const { requireElevatedApi } = await loadMiddleware()
    for (const role of ['admin', 'super_admin']) {
      const context = ctx('/api/hermes/providers', role)
      await requireElevatedApi(context, context.next)
      expect(context.status).toBe(200)
    }
  })

  it('passes non-API paths through regardless of role', async () => {
    const { requireElevatedApi } = await loadMiddleware()
    const context = ctx('/', 'user')
    await requireElevatedApi(context, context.next)
    expect(context.status).toBe(200)
  })
})

describe('OIDC configuration parsing', () => {
  const originalEnv = process.env

  beforeEach(() => {
    vi.resetModules()
    process.env = { ...originalEnv }
    delete process.env.HERMES_SSO_ISSUER
    delete process.env.HERMES_SSO_CLIENT_ID
    delete process.env.HERMES_SSO_CLIENT_SECRET
    delete process.env.HERMES_SSO_SCOPES
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it('is disabled without configuration', async () => {
    const oidc = await import('../../packages/server/src/modules/studio/services/auth/oidc')
    expect(oidc.isSsoConfigured()).toBe(false)
    expect(oidc.getSsoConfig()).toBeNull()
  })

  it('rejects plain HTTP issuers except localhost', async () => {
    const oidc = await import('../../packages/server/src/modules/studio/services/auth/oidc')
    process.env.HERMES_SSO_ISSUER = 'http://sso.example.com'
    process.env.HERMES_SSO_CLIENT_ID = 'client'
    process.env.HERMES_SSO_CLIENT_SECRET = 'secret'
    expect(oidc.isSsoConfigured()).toBe(false)

    process.env.HERMES_SSO_ISSUER = 'http://localhost:8080'
    expect(oidc.isSsoConfigured()).toBe(true)

    process.env.HERMES_SSO_ISSUER = 'https://sso.example.com/'
    const config = oidc.getSsoConfig()
    expect(config!.issuer).toBe('https://sso.example.com')
    expect(config!.scopes).toBe('openid profile email')
  })

  it('round-trips SSO state entries and expires them', async () => {
    const oidc = await import('../../packages/server/src/modules/studio/services/auth/oidc')
    oidc.clearSsoState()
    const stateStore = (oidc as any).__internals.stateStore as Map<string, { expiresAt: number }>
    stateStore.set('state-1', {
      codeVerifier: 'verifier',
      nonce: 'nonce',
      inviteCode: 'invite-9',
      redirectUri: 'https://app/callback',
      expiresAt: Date.now() + 60_000,
    })

    const entry = oidc.takeSsoState('state-1')
    expect(entry).not.toBeNull()
    expect(entry!.inviteCode).toBe('invite-9')
    // single use
    expect(oidc.takeSsoState('state-1')).toBeNull()

    stateStore.set('state-2', {
      codeVerifier: 'v',
      nonce: 'n',
      inviteCode: '',
      redirectUri: 'https://app/callback',
      expiresAt: Date.now() - 1,
    })
    expect(oidc.takeSsoState('state-2')).toBeNull()
  })
})
