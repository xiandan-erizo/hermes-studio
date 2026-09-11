import Koa from 'koa'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mcpAppSandboxRoutes } from '../../packages/server/src/modules/studio/routes/mcp-app-sandbox'
import { securityHeaders } from '../../packages/server/src/modules/studio/middleware/security'

function app() {
  const server = new Koa()
  server.use(securityHeaders())
  server.use(mcpAppSandboxRoutes.routes())
  server.use(ctx => { ctx.status = 401 })
  return server
}

describe('MCP App sandbox document', () => {
  let server: Server
  let origin: string
  beforeAll(async () => {
    server = app().listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterAll(() => new Promise<void>(resolve => server.close(() => resolve())))
  const get = (params: Record<string, string>, headers?: HeadersInit) => fetch(
    `${origin}/api/studio/mcp-apps/sandbox?${new URLSearchParams(params)}`, { headers },
  )
  it('serves a public proxy with an enforced resource CSP and a specific parent', async () => {
    const response = await get({
      parentOrigin: 'https://studio.example.test',
      csp: JSON.stringify({ connectDomains: ['https://api.example.test'], resourceDomains: [] }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('x-frame-options')).toBeNull()
    expect(response.headers.get('content-security-policy')).toContain('frame-ancestors https://studio.example.test')
    expect(response.headers.get('content-security-policy')).toContain('connect-src https://api.example.test')
    expect(response.headers.get('content-security-policy')).toContain("script-src 'unsafe-inline'")
  })

  it('rejects same-origin embedding and invalid origin or CSP input', async () => {
    for (const params of [
      { parentOrigin: 'javascript:alert(1)' },
      { parentOrigin: 'https://user:secret@example.test' },
      { parentOrigin: 'https://studio.example.test/path' },
      { parentOrigin: 'https://studio.example.test', csp: 'not-json' },
      { parentOrigin: 'https://studio.example.test', csp: JSON.stringify({ resourceDomains: ["https://cdn.test; script-src *"] }) },
    ]) expect((await get(params)).status).toBe(400)
    expect((await get({ parentOrigin: origin })).status).toBe(400)
  })

  it('keeps unrelated API paths private', async () => {
    expect((await fetch(`${origin}/api/studio/mcp-apps/other`)).status).toBe(401)
  })
})
