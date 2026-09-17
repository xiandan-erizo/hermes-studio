import Koa from 'koa'
import { bodyParser } from '@koa/bodyparser'
import { createServer, type Server } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ db: null as unknown as DatabaseSync, call: vi.fn(), resolve: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/infrastructure/database', () => ({ getDb: () => fixture.db, isSqliteAvailable: () => true }))
vi.mock('../../packages/server/src/modules/hermes/services/bridge/client', () => ({ AgentBridgeClient: class { mcpAppCallTool = fixture.call; mcpAppResolve = fixture.resolve } }))
import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { createSession, addMessage } from '../../packages/server/src/modules/studio/repositories/session-store'
import { mcpAppRoutes } from '../../packages/server/src/modules/hermes/routes/mcp'
import { mcpAppContextPrompt } from '../../packages/server/src/modules/studio/repositories/mcp-app-context-store'

let server: Server
let url: string
const binding = { sessionId: 's1', toolCallId: 'call1', toolName: 'mcp__demo__render' }
beforeEach(async () => {
  fixture.db = new DatabaseSync(':memory:')
  fixture.db.exec('PRAGMA foreign_keys=ON')
  initAllHermesTables()
  createSession({ id: 's1', profile: 'work', owner_user_id: 7 })
  addMessage({ session_id: 's1', role: 'tool', tool_call_id: 'call1', tool_name: binding.toolName, content: '{"content":[{"type":"text","text":"ready"}]}' })
  fixture.call.mockReset().mockResolvedValue({ ok: true, result: { content: [], structuredContent: { version: 2 } } })
  fixture.resolve.mockReset().mockResolvedValue({ ok: true, resource: { uri: 'ui://demo/card.html' } })
  const app = new Koa()
  app.use(bodyParser())
  app.use(async (ctx, next) => {
    ctx.state.user = { id: ctx.get('x-other-user') ? 8 : 7, username: 'member', role: 'user' }
    ctx.state.profile = { name: 'work' }
    await next()
  })
  app.use(mcpAppRoutes.routes())
  server = createServer(app.callback())
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/hermes/mcp/apps/`
})
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  fixture.db.close()
})
function post(path: string, body: unknown, otherUser = false) {
  return fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(otherUser ? { 'x-other-user': '1' } : {}) }, body: JSON.stringify(body) })
}

it('allows an owned App call and rejects cross-user, missing invocation and transport metadata', async () => {
  const body = { ...binding, params: { name: 'update', arguments: { version: 1 } } }
  const response = await post('call-tool', body)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ content: [], structuredContent: { version: 2 } })
  expect(fixture.call).toHaveBeenCalledWith(binding.toolName, 'update', { version: 1 }, 'work')
  expect((await post('call-tool', body, true)).status).toBe(404)
  expect((await post('call-tool', { ...body, toolCallId: 'foreign' })).status).toBe(404)
  expect((await post('call-tool', { ...body, params: { ...body.params, _meta: { credentials: 'forged' } } })).status).toBe(400)
  expect(fixture.call).toHaveBeenCalledTimes(1)
})

it('stores only the latest standard context without executing a tool or run', async () => {
  for (const version of [1, 2]) {
    const response = await post('model-context', { ...binding, params: { structuredContent: { version } } })
    expect(response.status).toBe(200)
  }
  expect(mcpAppContextPrompt('s1', 'work')).toContain('"version":2')
  expect(mcpAppContextPrompt('s1', 'work')).not.toContain('"version":1')
  expect(fixture.call).not.toHaveBeenCalled()
  expect((await post('model-context', { ...binding, params: { content: [{ type: 'text', text: 'private' }] } }, true)).status).toBe(404)
  expect(mcpAppContextPrompt('s1', 'work')).not.toContain('private')
})
