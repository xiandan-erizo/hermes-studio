import { beforeEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

const fixture = vi.hoisted(() => ({ db: null as unknown as DatabaseSync }))
vi.mock('../../packages/server/src/modules/studio/infrastructure/database', () => ({ getDb: () => fixture.db }))
import { MCP_APP_CONTEXT_SCHEMA } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { saveMcpAppContext, mcpAppContextPrompt } from '../../packages/server/src/modules/studio/repositories/mcp-app-context-store'

beforeEach(() => {
  fixture.db?.close()
  fixture.db = new DatabaseSync(':memory:')
  fixture.db.exec('PRAGMA foreign_keys=ON; CREATE TABLE sessions(id TEXT PRIMARY KEY); INSERT INTO sessions VALUES (\'s1\'), (\'s2\');')
  fixture.db.exec(`CREATE TABLE mcp_app_context (${Object.entries(MCP_APP_CONTEXT_SCHEMA).map(([k, v]) => `${k} ${v}`).join(',')})`)
})

it('replaces a view snapshot, separates profiles/sessions, and cascades deletion', () => {
  const binding = { sessionId: 's1', toolName: 'mcp__demo__render', toolCallId: 'one' }
  saveMcpAppContext('work', binding, { structuredContent: { version: 1 } })
  saveMcpAppContext('work', binding, { structuredContent: { version: 2 } })
  const prompt = mcpAppContextPrompt('s1', 'work')
  expect(prompt).toContain('"version":2')
  expect(prompt).not.toContain('"version":1')
  expect(prompt).toContain('untrusted UI data')
  expect(mcpAppContextPrompt('s2', 'work')).toBe('')
  expect(mcpAppContextPrompt('s1', 'private')).toBe('')
  fixture.db.prepare('DELETE FROM sessions WHERE id=?').run('s1')
  expect(mcpAppContextPrompt('s1', 'work')).toBe('')
})

it('limits recalled context to eight views', () => {
  for (let i = 0; i < 12; i++) saveMcpAppContext('work', { sessionId: 's1', toolName: 'mcp__demo__render', toolCallId: String(i) }, { content: [] })
  expect(fixture.db.prepare('SELECT COUNT(*) as n FROM mcp_app_context').get()?.n).toBe(8)
})
