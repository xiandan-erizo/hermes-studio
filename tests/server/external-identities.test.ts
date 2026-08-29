import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('External channel identity mapping', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
      isSqliteAvailable: () => true,
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
    return await import('../../packages/server/src/modules/studio/repositories/external-identities-store')
  }

  it('stores and resolves channel identity mappings', async () => {
    const store = await loadStore()
    const created = store.createExternalIdentity({ source: 'Feishu', externalId: 'ou_abc123', userId: 5, note: 'hose' })
    expect(created).toMatchObject({ source: 'feishu', external_id: 'ou_abc123', user_id: 5, note: 'hose' })
    expect(store.findMappedUserId('feishu', 'ou_abc123')).toBe(5)
    expect(store.findMappedUserId('feishu', 'ou_other')).toBeNull()
    // unique per (source, external_id)
    const dup = store.createExternalIdentity({ source: 'feishu', externalId: 'ou_abc123', userId: 6 })
    expect(dup).toEqual({ conflict: true })
    expect(store.deleteExternalIdentity(created!.id)).toBe(true)
    expect(store.findMappedUserId('feishu', 'ou_abc123')).toBeNull()
  })

  it('rejects non-channel sources', async () => {
    const store = await loadStore()
    expect(store.createExternalIdentity({ source: 'cli', externalId: 'x', userId: 1 })).toBeNull()
    expect(store.isChannelSource('dingtalk')).toBe(true)
    expect(store.isChannelSource('cli')).toBe(false)
  })
})

describe('Channel history access via mapping', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
      isSqliteAvailable: () => true,
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

  it('mapped plain user reads feishu history read-only; unmapped stays invisible', async () => {
    const users = await import('../../packages/server/src/modules/studio/repositories/users-store')
    const user = users.createUser({ username: 'feishu_user', password: 'secret12', role: 'user', profiles: ['default'] })
    const other = users.createUser({ username: 'other_user', password: 'secret12', role: 'user', profiles: ['default'] })

    const store = await import('../../packages/server/src/modules/studio/repositories/external-identities-store')
    store.createExternalIdentity({ source: 'feishu', externalId: 'ou_ef87a5', userId: Number(user!.id) })

    const { resolveSessionAccess, denySessionRead, denySessionOperation } = await import('../../packages/server/src/modules/studio/services/session-access')
    // Hermes state.db history shape (channel source + user_id)
    const hermesRow = { source: 'feishu', user_id: 'ou_ef87a5', owner_user_id: null }

    expect(resolveSessionAccess({ id: user!.id, role: 'user' }, hermesRow)).toBe('read_external')
    expect(resolveSessionAccess({ id: other!.id, role: 'user' }, hermesRow)).toBe('none')
    expect(resolveSessionAccess(null, hermesRow)).toBe('none')

    const ctx: any = { state: { user: { id: user!.id, role: 'user' } } }
    expect(denySessionRead(ctx, hermesRow)).toBe(false)
    expect(denySessionOperation(ctx, hermesRow)).toBe(true)
    expect(ctx.status).toBe(403)
  })

  it('studio-shaped sessions with external_actor fields resolve through the same mapping', async () => {
    const users = await import('../../packages/server/src/modules/studio/repositories/users-store')
    const user = users.createUser({ username: 'ding_user', password: 'secret12', role: 'user', profiles: ['default'] })
    const store = await import('../../packages/server/src/modules/studio/repositories/external-identities-store')
    store.createExternalIdentity({ source: 'dingtalk', externalId: '$:LWCP_v1:$abc', userId: Number(user!.id) })

    const { resolveSessionAccess } = await import('../../packages/server/src/modules/studio/services/session-access')
    const studioRow = { owner_user_id: null, external_actor_source: 'dingtalk', external_actor_id: '$:LWCP_v1:$abc' }
    expect(resolveSessionAccess({ id: user!.id, role: 'user' }, studioRow)).toBe('read_external')
    expect(resolveSessionAccess({ id: user!.id, role: 'user' }, { owner_user_id: null, external_actor_source: 'dingtalk', external_actor_id: 'other' })).toBe('none')
  })

  it('disabled mapped users lose access', async () => {
    const users = await import('../../packages/server/src/modules/studio/repositories/users-store')
    const user = users.createUser({ username: 'gone_user', password: 'secret12', role: 'user', profiles: ['default'] })
    const store = await import('../../packages/server/src/modules/studio/repositories/external-identities-store')
    store.createExternalIdentity({ source: 'feishu', externalId: 'ou_x1', userId: Number(user!.id) })
    db.prepare('UPDATE users SET status = ? WHERE id = ?').run('disabled', user!.id)

    const { resolveSessionAccess } = await import('../../packages/server/src/modules/studio/services/session-access')
    expect(resolveSessionAccess({ id: user!.id, role: 'user' }, { source: 'feishu', user_id: 'ou_x1' })).toBe('none')
  })
})
