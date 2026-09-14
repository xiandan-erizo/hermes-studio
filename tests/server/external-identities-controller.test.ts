import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('external identity HTTP behavior', () => {
  let db: any
  let userId: number
  let sessions: Array<{ source: string; user_id: string }>
  let historyUnavailable: boolean
  let ctrl: typeof import('../../packages/server/src/modules/studio/controllers/external-identities')

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db, getStoragePath: () => ':memory:', isSqliteAvailable: () => true,
    }))
    // Prevent real history/database access by the old controller before migration.
    vi.doMock('../../packages/server/src/modules/hermes/services/history/sessions-db', () => ({
      listSessionSummaries: async () => { throw new Error('Direct runtime access is unavailable') },
    }))
    vi.doMock('../../packages/server/src/modules/studio/public/session-agent-runtime', () => ({
      listHermesSessionSummaries: async (profile: unknown, limit: number) => {
        expect([profile, limit]).toEqual([undefined, 5000])
        if (historyUnavailable) throw new Error('History unavailable')
        return sessions
      },
    }))
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
    const users = await import('../../packages/server/src/modules/studio/public/users')
    userId = Number(users.createUser({ username: 'member', password: 'secret12', role: 'user', profiles: ['default'] })!.id)
    sessions = []
    historyUnavailable = false
    ctrl = await import('../../packages/server/src/modules/studio/controllers/external-identities')
  })
  afterEach(() => {
    db?.close()
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.doUnmock('../../packages/server/src/modules/hermes/services/history/sessions-db')
    vi.doUnmock('../../packages/server/src/modules/studio/public/session-agent-runtime')
    vi.resetModules()
  })
  const ctx = (body?: unknown, id?: unknown): any => ({ request: { body }, params: { id }, status: 200 })

  it('counts channel candidates from the runtime facade and preserves source-specific identities', async () => {
    sessions = [
      { source: 'feishu', user_id: ' actor ' }, { source: 'feishu', user_id: 'actor' },
      { source: 'dingtalk', user_id: 'actor' }, { source: 'cli', user_id: 'local' },
      { source: 'wecom', user_id: '  ' },
    ]
    const response = ctx()
    await ctrl.listCandidates(response)
    expect(response.body).toEqual({ candidates: [
      { source: 'feishu', external_id: 'actor', session_count: 2 },
      { source: 'dingtalk', external_id: 'actor', session_count: 1 },
    ] })
  })
  it('keeps the empty-candidate fallback when history is unavailable', async () => {
    historyUnavailable = true
    const response = ctx()
    await ctrl.listCandidates(response)
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ candidates: [] })
  })
  it('preserves creation, conflict, listing and deletion responses using real storage', async () => {
    const body = { source: ' Feishu ', external_id: ' actor ', user_id: String(userId), note: 'x'.repeat(220) }
    const created = ctx(body)
    await ctrl.createMapping(created)
    expect(created.status).toBe(201)
    expect(created.body.mapping).toMatchObject({ source: 'feishu', external_id: 'actor', user_id: userId, username: 'member', note: 'x'.repeat(200) })
    const duplicate = ctx(body)
    await ctrl.createMapping(duplicate)
    expect(duplicate.status).toBe(409)
    expect(duplicate.body).toEqual({ error: 'A mapping for this source and external_id already exists' })
    const listed = ctx()
    await ctrl.listMappings(listed)
    expect(listed.body).toEqual({ mappings: [created.body.mapping] })
    const deleted = ctx(undefined, created.body.mapping.id)
    await ctrl.removeMapping(deleted)
    expect(deleted.body).toEqual({ success: true })
    await ctrl.removeMapping(deleted)
    expect(deleted.status).toBe(404)
    expect(deleted.body).toEqual({ error: 'Mapping not found' })
  })
  it('retains validation responses and active-only minimal user choices', async () => {
    for (const [body, error] of [
      [undefined, 'source must be one of feishu/dingtalk/weixin/wecom/webhook'],
      [{ source: 'weixin', external_id: ' ' }, 'external_id is required'],
      [{ source: 'weixin', external_id: 'actor', user_id: -1 }, 'user_id must reference an existing user'],
    ] as const) {
      const response = ctx(body)
      await ctrl.createMapping(response)
      expect(response.status).toBe(400)
      expect(response.body).toEqual({ error })
    }
    const invalid = ctx(undefined, 'bad')
    await ctrl.removeMapping(invalid)
    expect(invalid.status).toBe(400)
    expect(invalid.body).toEqual({ error: 'Invalid mapping id' })
    const picker = ctx()
    await ctrl.listMappingUsers(picker)
    expect(picker.body).toEqual({ users: [{ id: userId, username: 'member' }] })
    db.prepare('UPDATE users SET status = ? WHERE id = ?').run('disabled', userId)
    await ctrl.listMappingUsers(picker)
    expect(picker.body).toEqual({ users: [] })
  })
})
