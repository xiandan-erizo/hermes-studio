/**
 * Tests for the channel-session refresh service: imported channel
 * conversations (feishu/dingtalk/...) are rebuilt from the agent's state.db
 * when its message count drifts from the local snapshot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('channel-session-refresh', () => {
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
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.resetModules()
  })

  async function initTestDb() {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    initAllStores()
  }

  async function load(count: (sessionId: string, profile: string) => Promise<number | null>, detail: any) {
    const runtime = await import('../../packages/server/src/modules/studio/public/session-agent-runtime')
    runtime.configureSessionAgentRuntime({
      deleteHermesSessionForProfile: vi.fn(),
      getHermesCliSession: vi.fn(),
      getHermesModelContextLength: vi.fn(() => 0),
      getHermesSessionDetail: vi.fn(),
      getHermesSessionDetailForProfile: vi.fn(async () => detail),
      getHermesSessionDetailPaginatedForProfile: vi.fn(),
      getHermesSessionMessageCountForProfile: vi.fn(count),
      getHermesAncestorSessionRows: vi.fn(async () => []),
      getExactHermesSessionDetailForProfile: vi.fn(),
      getHermesUsageStats: vi.fn(),
      listHermesSessionSummaries: vi.fn(async () => []),
      listHermesSessionSummaryGroups: vi.fn(),
      notifyHermesSessionModelChanged: vi.fn(),
      stopCodingAgentSessionRun: vi.fn(),
    })
    return await import('../../packages/server/src/modules/studio/services/channel-session-refresh')
  }

  function insertChannelSession(id: string) {
    db.prepare(`
      INSERT INTO sessions (id, profile, source, model, title, started_at, last_active)
      VALUES (?, 'default', 'feishu', 'gpt-x', 'Old Title', 100, 100)
    `).run(id)
  }

  function insertLocalMessages(id: string, texts: string[]) {
    for (const text of texts) {
      db.prepare(`
        INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, run_marker, timestamp, token_count)
        VALUES (?, 'user', ?, NULL, NULL, NULL, NULL, 200, NULL)
      `).run(id, text)
    }
    db.prepare('UPDATE sessions SET message_count = ? WHERE id = ?').run(texts.length, id)
  }

  function localMessageCount(id: string): number {
    return (db.prepare('SELECT COUNT(*) AS cnt FROM messages WHERE session_id = ?').get(id) as { cnt: number }).cnt
  }

  it('rebuilds a channel session when state.db has more messages', async () => {
    await initTestDb()
    insertChannelSession('sess-a')
    insertLocalMessages('sess-a', ['local one'])
    const detail = {
      id: 'sess-a',
      source: 'feishu',
      user_id: 'ou_x',
      title: 'New Title',
      ended_at: null,
      end_reason: null,
      tool_call_count: 1,
      message_count: 3,
      messages: [
        { role: 'user', content: 'feishu one', timestamp: 300 },
        { role: 'assistant', content: 'feishu two', timestamp: 301 },
        { role: 'user', content: 'webui three', timestamp: 302 },
      ],
    }
    const { refreshChannelSessionFromHermes } = await load(async () => 3, detail)

    expect(await refreshChannelSessionFromHermes('sess-a', 'default')).toBe(true)
    expect(localMessageCount('sess-a')).toBe(3)
    const row = db.prepare('SELECT title FROM sessions WHERE id = ?').get('sess-a') as { title: string }
    expect(row.title).toBe('New Title')
  })

  it('is a no-op when the counts match', async () => {
    await initTestDb()
    insertChannelSession('sess-b')
    insertLocalMessages('sess-b', ['one', 'two'])
    const detail = { id: 'sess-b', source: 'feishu', messages: [{ role: 'user', content: 'should not run' }] }
    const { refreshChannelSessionFromHermes } = await load(async () => 2, detail)

    expect(await refreshChannelSessionFromHermes('sess-b', 'default')).toBe(false)
    expect(localMessageCount('sess-b')).toBe(2)
  })

  it('does not rebuild again when upstream contains filtered metadata messages', async () => {
    await initTestDb()
    insertChannelSession('sess-meta')
    insertLocalMessages('sess-meta', ['old'])
    const detail = {
      id: 'sess-meta',
      source: 'feishu',
      user_id: 'ou_x',
      message_count: 3,
      messages: [
        { role: 'session_meta', content: '{"channel":"feishu"}', timestamp: 299 },
        { role: 'user', content: 'hello', timestamp: 300 },
        { role: 'assistant', content: 'hi', timestamp: 301 },
      ],
    }
    const { refreshChannelSessionFromHermes } = await load(async () => 3, detail)

    expect(await refreshChannelSessionFromHermes('sess-meta', 'default')).toBe(true)
    expect(localMessageCount('sess-meta')).toBe(2)
    expect(await refreshChannelSessionFromHermes('sess-meta', 'default')).toBe(false)
  })

  it('ignores non-channel sessions', async () => {
    await initTestDb()
    db.prepare(`
      INSERT INTO sessions (id, profile, source, model, started_at, last_active)
      VALUES ('sess-c', 'default', 'cli', 'gpt-x', 100, 100)
    `).run()
    const { refreshChannelSessionFromHermes } = await load(async () => 99, {})

    expect(await refreshChannelSessionFromHermes('sess-c', 'default')).toBe(false)
  })

  it('is a no-op when the session is missing from state.db', async () => {
    await initTestDb()
    insertChannelSession('sess-d')
    insertLocalMessages('sess-d', ['one'])
    const { refreshChannelSessionFromHermes } = await load(async () => null, null)

    expect(await refreshChannelSessionFromHermes('sess-d', 'default')).toBe(false)
    expect(localMessageCount('sess-d')).toBe(1)
  })
})
