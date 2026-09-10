import Koa from 'koa'
import { createServer, type Server as HttpServer } from 'http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerRoutes } from '../../packages/server/src/bootstrap/routes'

function listen(server: HttpServer): Promise<string> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    resolve(`http://127.0.0.1:${address.port}`)
  }))
}

describe('role-based HTTP route access', () => {
  let server: HttpServer
  let baseUrl = ''

  beforeEach(async () => {
    const app = new Koa()
    registerRoutes(app, [async (ctx, next) => {
      const requestedRole = ctx.get('x-test-role')
      const role = requestedRole === 'admin' || requestedRole === 'super_admin'
        ? requestedRole
        : 'user'
      ctx.state.user = { id: 7, username: 'member', role, profiles: ['default'] }
      if (ctx.get('x-test-no-profile') !== '1') ctx.state.profile = { name: 'default' }
      await next()
    }])
    server = createServer(app.callback())
    baseUrl = await listen(server)
  })

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('lets plain users read chat prerequisites', async () => {
    for (const path of ['/api/agents/availability', '/api/hermes/skills']) {
      const response = await fetch(`${baseUrl}${path}`)
      expect(response.status, path).toBe(200)
    }
  })

  it('requires a validated Profile for the plain-user display config', async () => {
    const response = await fetch(`${baseUrl}/api/hermes/config`, {
      headers: { 'x-test-no-profile': '1' },
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Profile is required' })
  })

  it('blocks plain users from management surfaces', async () => {
    const paths = [
      '/api/studio/workflows',
      '/api/hermes/marketplace/installed',
      '/api/auth/locked-ips',
      '/api/studio/workspace/folders',
      '/api/studio/group-chat/rooms',
      '/api/hermes/jobs',
      '/api/hermes/kanban',
      '/api/hermes/journey',
      '/api/theme',
      '/api/studio/files/list',
      '/api/studio/pets/active',
      '/api/studio/petdex/manifest',
    ]
    const statuses = Object.fromEntries(await Promise.all(paths.map(async path => {
      const response = await fetch(`${baseUrl}${path}`)
      return [path, response.status]
    })))

    expect(statuses).toEqual(Object.fromEntries(paths.map(path => [path, 403])))
  })

  it('keeps management available to admins and platform inventory limited to super admins', async () => {
    for (const path of ['/api/studio/workflows', '/api/hermes/marketplace/installed']) {
      const response = await fetch(`${baseUrl}${path}`, { headers: { 'x-test-role': 'admin' } })
      expect(response.status, path).not.toBe(403)
    }

    for (const path of ['/api/agents/status', '/api/auth/locked-ips']) {
      const adminResponse = await fetch(`${baseUrl}${path}`, { headers: { 'x-test-role': 'admin' } })
      const superAdminResponse = await fetch(`${baseUrl}${path}`, { headers: { 'x-test-role': 'super_admin' } })
      expect(adminResponse.status, path).toBe(403)
      expect(superAdminResponse.status, path).toBe(200)
    }
  })
})
