import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('Session identity descriptor', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE users (
      id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT DEFAULT '', role TEXT DEFAULT 'user',
      status TEXT DEFAULT 'active', created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0,
      last_login_at INTEGER, avatar TEXT DEFAULT '')`)
    db.exec(`CREATE TABLE sso_identities (
      id INTEGER PRIMARY KEY, provider TEXT DEFAULT 'oidc', subject TEXT, username TEXT DEFAULT '',
      display_name TEXT DEFAULT '', email TEXT DEFAULT '', user_id INTEGER, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0)`)
    db.exec(`CREATE TABLE external_identities (
      id INTEGER PRIMARY KEY, source TEXT, external_id TEXT, user_id INTEGER, note TEXT DEFAULT '',
      created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0)`)
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
    }))
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.resetModules()
  })

  async function load() {
    return await import('../../packages/server/src/modules/studio/services/session-access')
  }

  function insertUser(id: number, username: string) {
    db.prepare('INSERT INTO users (id, username, role, status) VALUES (?, ?, ?, ?)').run(id, username, 'user', 'active')
  }

  function insertSso(userId: number, email: string, displayName: string) {
    db.prepare(
      "INSERT INTO sso_identities (provider, subject, username, display_name, email, user_id) VALUES ('oidc', 'sub-1', 'sso-user', ?, ?, ?)",
    ).run(displayName, email, userId)
  }

  it('returns the owner user with SSO profile fields', async () => {
    insertUser(3, 'sunkesi')
    insertSso(3, 'sunkesi@hosecloud.com', 'Sun Kesi')
    const { describeSessionIdentity } = await load()
    const identity = describeSessionIdentity({ owner_user_id: 3 })
    expect(identity).toMatchObject({
      kind: 'user',
      user_id: 3,
      username: 'sunkesi',
      display_name: 'Sun Kesi',
      email: 'sunkesi@hosecloud.com',
    })
    expect(identity.sso).toMatchObject({ provider: 'oidc', email: 'sunkesi@hosecloud.com' })
  })

  it('falls back to an email-style username when no SSO identity exists', async () => {
    insertUser(2, 'sunkesi@hosecloud.com')
    const { describeSessionIdentity } = await load()
    expect(describeSessionIdentity({ owner_user_id: 2 })).toMatchObject({
      kind: 'user',
      email: 'sunkesi@hosecloud.com',
      sso: null,
    })
  })

  it('returns the mapped Studio user for a channel actor', async () => {
    insertUser(5, 'feishu-user')
    insertSso(5, 'feishu-user@hosecloud.com', 'Feishu User')
    db.prepare("INSERT INTO external_identities (source, external_id, user_id) VALUES ('feishu', 'ou_abc', 5)").run()
    const { describeSessionIdentity } = await load()
    expect(describeSessionIdentity({ external_actor_source: 'feishu', external_actor_id: 'ou_abc' })).toMatchObject({
      kind: 'channel_user',
      channel: { source: 'feishu', external_id: 'ou_abc' },
      user_id: 5,
      email: 'feishu-user@hosecloud.com',
    })
  })

  it('returns the raw channel actor when no user is mapped', async () => {
    const { describeSessionIdentity } = await load()
    expect(describeSessionIdentity({ external_actor_source: 'feishu', external_actor_id: 'ou_x' })).toMatchObject({
      kind: 'channel',
      channel: { source: 'feishu', external_id: 'ou_x' },
    })
  })

  it('reports anonymous when nothing is bound', async () => {
    const { describeSessionIdentity } = await load()
    expect(describeSessionIdentity({})).toMatchObject({ kind: 'anonymous' })
    expect(describeSessionIdentity(null)).toMatchObject({ kind: 'anonymous' })
  })

  it('notes a missing owner record', async () => {
    const { describeSessionIdentity } = await load()
    expect(describeSessionIdentity({ owner_user_id: 999 })).toMatchObject({
      kind: 'user',
      user_id: 999,
      note: 'owner user record is missing',
    })
  })

  describe('channel conversation operate access', () => {
    it('lets the mapped user operate a channel conversation', async () => {
      insertUser(3, 'sunkesi')
      db.prepare("INSERT INTO external_identities (source, external_id, user_id) VALUES ('feishu', 'ou_abc', 3)").run()
      const { canOperateSession, resolveSessionAccess } = await load()
      const channelSession = { source: 'feishu', user_id: 'ou_abc' }
      expect(resolveSessionAccess({ id: 3, role: 'user' }, channelSession)).toBe('read_external')
      expect(canOperateSession({ id: 3, role: 'user' }, channelSession)).toBe(true)
      expect(canOperateSession({ id: 1, role: 'super_admin' }, channelSession)).toBe(true)
      expect(canOperateSession({ id: 4, role: 'user' }, channelSession)).toBe(false)
    })

    it('uses the mapped channel actor instead of a stale imported owner', async () => {
      insertUser(3, 'mapped-user')
      insertUser(5, 'stale-importer')
      db.prepare("INSERT INTO external_identities (source, external_id, user_id) VALUES ('feishu', 'ou_abc', 3)").run()
      const { describeSessionIdentity, resolveSessionAccess } = await load()
      const channelSession = {
        source: 'feishu',
        user_id: 'ou_abc',
        owner_user_id: 5,
        ownership_state: 'owned',
      }

      expect(describeSessionIdentity(channelSession)).toMatchObject({
        kind: 'channel_user',
        user_id: 3,
        channel: { source: 'feishu', external_id: 'ou_abc' },
      })
      expect(resolveSessionAccess({ id: 3, role: 'user' }, channelSession)).toBe('read_external')
      expect(resolveSessionAccess({ id: 5, role: 'user' }, channelSession)).toBe('none')
    })

    it('does not expose a stale owner when a channel session has no actor id', async () => {
      insertUser(5, 'stale-importer')
      const { describeSessionIdentity, resolveSessionAccess } = await load()
      const channelSession = {
        source: 'dingtalk',
        user_id: null,
        owner_user_id: 5,
        ownership_state: 'owned',
      }

      expect(describeSessionIdentity(channelSession)).toMatchObject({
        kind: 'anonymous',
        note: 'channel session has no external actor',
      })
      expect(resolveSessionAccess({ id: 5, role: 'user' }, channelSession)).toBe('none')
    })

    it('keeps destructive operations owner/admin-only for the mapped user', async () => {
      insertUser(3, 'sunkesi')
      db.prepare("INSERT INTO external_identities (source, external_id, user_id) VALUES ('feishu', 'ou_abc', 3)").run()
      const { denySessionOperation } = await load()
      const ctx: any = { state: { user: { id: 3, role: 'user' } }, status: 0, body: null }
      expect(denySessionOperation(ctx, { source: 'feishu', user_id: 'ou_abc' })).toBe(true)
      expect(ctx.status).toBe(403)
      expect(ctx.body).toMatchObject({ error: 'Session is read-only for this account' })
    })

    it('keeps inherited external-actor rows on non-channel sessions read-only', async () => {
      insertUser(3, 'sunkesi')
      db.prepare("INSERT INTO external_identities (source, external_id, user_id) VALUES ('feishu', 'ou_abc', 3)").run()
      const { canOperateSession, resolveSessionAccess } = await load()
      const subagentRow = { source: 'subagent', external_actor_source: 'feishu', external_actor_id: 'ou_abc' }
      expect(resolveSessionAccess({ id: 3, role: 'user' }, subagentRow)).toBe('read_external')
      expect(canOperateSession({ id: 3, role: 'user' }, subagentRow)).toBe(false)
    })
  })

  describe('shouldClaimSessionOwnership', () => {
    it('claims state-less legacy sessions', async () => {
      const { shouldClaimSessionOwnership } = await load()
      expect(shouldClaimSessionOwnership({ source: 'cli', owner_user_id: null, ownership_state: null }, { id: 3 })).toBe(true)
      expect(shouldClaimSessionOwnership({ source: 'api_server' }, { id: 3 })).toBe(true)
    })

    it('never claims channel conversations', async () => {
      const { shouldClaimSessionOwnership } = await load()
      expect(shouldClaimSessionOwnership({ source: 'feishu', user_id: 'ou_x' }, { id: 3 })).toBe(false)
      expect(shouldClaimSessionOwnership({ source: 'dingtalk' }, { id: 1, role: 'super_admin' })).toBe(false)
    })

    it('skips owned sessions and anonymous callers', async () => {
      const { shouldClaimSessionOwnership } = await load()
      expect(shouldClaimSessionOwnership({ source: 'cli', owner_user_id: 3, ownership_state: 'owned' }, { id: 3 })).toBe(false)
      expect(shouldClaimSessionOwnership({ source: 'cli' }, null)).toBe(false)
      expect(shouldClaimSessionOwnership(null, { id: 3 })).toBe(false)
    })
  })
})
