import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('Session ownership migration (P0)', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, profile TEXT DEFAULT 'default', source TEXT DEFAULT 'api_server',
      user_id TEXT, owner_user_id INTEGER, external_actor_source TEXT, external_actor_id TEXT,
      origin_source TEXT, origin_session_id TEXT, ownership_state TEXT, ownership_resolution TEXT,
      ownership_migration_version INTEGER)`)
    db.exec(`CREATE TABLE schema_migrations (migration_id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL, result_summary TEXT NOT NULL DEFAULT '')`)
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
    return await import('../../packages/server/src/modules/studio/services/session-ownership')
  }

  function insert(id: string, source: string, userId: string | null) {
    db.prepare('INSERT INTO sessions (id, source, user_id) VALUES (?, ?, ?)').run(id, source, userId)
  }

  it('assigns owners only for verified mappings; external/unresolved elsewhere', async () => {
    insert('mt762614one9sv', 'cli', '1')           // verified mapping -> owner 1
    insert('mt7d47641e9ti4', 'cli', '2')           // verified mapping -> owner 2
    insert('ext-1', 'feishu', 'ou_abc123')          // channel session -> external actor
    insert('ext-2', 'dingtalk', null)               // channel, no actor id
    insert('num-1', 'api_server', '3')              // numeric but NOT verified -> unresolved
    insert('num-2', 'cli', '999')                   // numeric, no such user -> unresolved
    const { migrateSessionOwnership } = await load()
    const summary = migrateSessionOwnership(db)

    expect(summary.owned).toBe(2)
    expect(summary.external).toBe(2)
    expect(summary.unresolved).toBe(2)

    const row = (id: string) => db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)
    expect(row('mt762614one9sv')).toMatchObject({ owner_user_id: 1, ownership_state: 'owned', ownership_resolution: 'migration_verified' })
    expect(row('ext-1')).toMatchObject({ ownership_state: 'external', external_actor_source: 'feishu', external_actor_id: 'ou_abc123', owner_user_id: null })
    expect(row('ext-2')).toMatchObject({ ownership_state: 'external', external_actor_id: null })
    expect(row('num-1')).toMatchObject({ ownership_state: 'unresolved', owner_user_id: null })
    expect(row('num-2')).toMatchObject({ ownership_state: 'unresolved', owner_user_id: null })
  })

  it('is idempotent and never overwrites admin-claimed owners', async () => {
    insert('mt86zv26m066ek', 'cli', '3')
    // someone already claimed an unresolved row manually
    db.prepare(`INSERT INTO sessions (id, source, user_id, owner_user_id, ownership_state, ownership_resolution)
                VALUES ('claimed-1', 'cli', '7', 42, 'owned', 'admin_claimed')`).run()
    const { migrateSessionOwnership } = await load()
    const first = migrateSessionOwnership(db)
    const second = migrateSessionOwnership(db) // re-run

    expect(second.migrated).toBe(0)
    expect(first.skippedAlreadyOwned).toBe(1)
    const claimed = db.prepare('SELECT owner_user_id FROM sessions WHERE id = ?').get('claimed-1')
    expect(claimed.owner_user_id).toBe(42)
  })

  it('re-runs only rows below the current migration version', async () => {
    insert('late-1', 'cli', '5')
    db.prepare('UPDATE sessions SET ownership_migration_version = 1 WHERE id = ?').run('late-1')
    const { migrateSessionOwnership } = await load()
    const summary = migrateSessionOwnership(db)
    // already at version 1 -> not reprocessed, stays unresolved-free
    const row = db.prepare('SELECT ownership_state FROM sessions WHERE id = ?').get('late-1')
    expect(row.ownership_state).toBeNull()
    expect(summary.migrated).toBe(0)
  })
})

describe('SessionAccessService matrix (P0)', () => {
  async function load() {
    return await import('../../packages/server/src/modules/studio/services/session-access')
  }

  const owner = { id: 10, role: 'user' }
  const otherUser = { id: 11, role: 'user' }
  const admin = { id: 12, role: 'admin' }
  const superAdmin = { id: 13, role: 'super_admin' }

  it('grants full access to every authenticated user after the Profile gate', async () => {
    const { resolveSessionAccess } = await load()
    const session = { owner_user_id: 10 }
    expect(resolveSessionAccess(owner, session)).toBe('full')
    expect(resolveSessionAccess(superAdmin, session)).toBe('full')
    expect(resolveSessionAccess(admin, session)).toBe('full')
    expect(resolveSessionAccess(otherUser, session)).toBe('full')
    expect(resolveSessionAccess(null, session)).toBe('none')
  })

  it('treats owner-less sessions as shared Profile resources', async () => {
    const { resolveSessionAccess } = await load()
    const legacy = { owner_user_id: null, ownership_state: 'unresolved' }
    expect(resolveSessionAccess(admin, legacy)).toBe('full')
    expect(resolveSessionAccess(owner, legacy)).toBe('full')
    expect(resolveSessionAccess(superAdmin, legacy)).toBe('full')
  })

  it('read and operate gates allow authenticated Profile members', async () => {
    const { denySessionRead, denySessionOperation } = await load()
    const member = { state: { user: otherUser } } as any
    expect(denySessionRead(member, { owner_user_id: 10 })).toBe(false)
    expect(denySessionOperation(member, { owner_user_id: 10 })).toBe(false)

    const anonymous = { state: {} } as any
    expect(denySessionRead(anonymous, { owner_user_id: 10 })).toBe(true)
    expect(anonymous.status).toBe(404)
  })

  it('keeps ownership fields as audit metadata only', async () => {
    const { resolveSessionAccess } = await load()
    const session = { owner_user_id: 99, user_id: '11' } as any
    expect(resolveSessionAccess(otherUser, session)).toBe('full')
  })
})

describe('session-store ownership writes (P0)', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, profile TEXT DEFAULT 'default', source TEXT DEFAULT 'api_server',
      agent TEXT DEFAULT '', agent_mode TEXT DEFAULT '', agent_session_id TEXT DEFAULT '',
      agent_native_session_id TEXT DEFAULT '', user_id TEXT, model TEXT DEFAULT '', provider TEXT DEFAULT '',
      api_mode TEXT DEFAULT '', reasoning_effort TEXT DEFAULT '', title TEXT, parent_session_id TEXT,
      fork_point_message_id TEXT, started_at INTEGER NOT NULL, ended_at INTEGER, end_reason TEXT,
      message_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0, billing_provider TEXT, estimated_cost_usd REAL DEFAULT 0,
      actual_cost_usd REAL, cost_status TEXT DEFAULT '', preview TEXT DEFAULT '', last_active INTEGER NOT NULL,
      is_archived INTEGER DEFAULT 0, push_enabled INTEGER DEFAULT 0, workspace TEXT, category_id INTEGER,
      history_revision INTEGER DEFAULT 0, owner_user_id INTEGER, external_actor_source TEXT, external_actor_id TEXT,
      origin_source TEXT, origin_session_id TEXT, ownership_state TEXT, ownership_resolution TEXT,
      ownership_migration_version INTEGER)`)
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
      isSqliteAvailable: () => true,
    }))
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.resetModules()
  })

  it('createSession persists owner + owned/created state', async () => {
    const store = await import('../../packages/server/src/modules/studio/repositories/session-store')
    store.createSession({ id: 's1', profile: 'default', title: 't', owner_user_id: 7 })
    const row = db.prepare('SELECT owner_user_id, ownership_state, ownership_resolution FROM sessions WHERE id = ?').get('s1')
    expect(row).toMatchObject({ owner_user_id: 7, ownership_state: 'owned', ownership_resolution: 'created' })
    const mapped = store.getSession('s1')
    expect(mapped?.owner_user_id).toBe(7)
    expect(mapped?.ownership_state).toBe('owned')
  })

  it('claimSessionOwnership only claims state-less rows', async () => {
    const store = await import('../../packages/server/src/modules/studio/repositories/session-store')
    db.prepare(`INSERT INTO sessions (id, started_at, last_active) VALUES ('a', 1, 1)`).run()
    db.prepare(`INSERT INTO sessions (id, started_at, last_active, owner_user_id, ownership_state, ownership_resolution)
                VALUES ('b', 1, 1, 5, 'owned', 'admin_claimed')`).run()
    db.prepare(`INSERT INTO sessions (id, started_at, last_active, ownership_state) VALUES ('c', 1, 1, 'unresolved')`).run()
    db.prepare(`INSERT INTO sessions (id, started_at, last_active, ownership_state) VALUES ('d', 1, 1, 'external')`).run()

    expect(store.claimSessionOwnership('a', 9)).toBe(true)
    expect(db.prepare('SELECT owner_user_id, ownership_resolution FROM sessions WHERE id = ?').get('a')).toMatchObject({ owner_user_id: 9, ownership_resolution: 'admin_claimed' })
    // claimed / unresolved / external rows are never re-claimed
    expect(store.claimSessionOwnership('b', 9)).toBe(false)
    expect(store.claimSessionOwnership('c', 9)).toBe(false)
    expect(store.claimSessionOwnership('d', 9)).toBe(false)
  })
})
