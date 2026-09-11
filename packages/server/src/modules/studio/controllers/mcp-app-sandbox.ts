import type { Context } from 'koa'
import { createSandboxDocument, sandboxOrigin } from '../services/mcp-apps/sandbox'

export async function serveMcpAppSandbox(ctx: Context): Promise<void> {
  try {
    const parent = typeof ctx.query.parentOrigin === 'string' ? ctx.query.parentOrigin : ''
    const rawCsp = typeof ctx.query.csp === 'string' ? ctx.query.csp : '{}'
    if (rawCsp.length > 16_384 || sandboxOrigin(parent) === ctx.origin) throw new Error('Invalid sandbox request')
    const { html, policy } = createSandboxDocument(parent, JSON.parse(rawCsp))
    ctx.remove('X-Frame-Options')
    ctx.set('Content-Security-Policy', policy)
    ctx.set('Cache-Control', 'no-store')
    ctx.set('Referrer-Policy', 'no-referrer')
    ctx.set('X-Content-Type-Options', 'nosniff')
    ctx.type = 'html'
    ctx.body = html
  } catch {
    ctx.status = 400
    ctx.body = { error: 'Invalid sandbox request' }
  }
}
