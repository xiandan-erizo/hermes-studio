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
})
