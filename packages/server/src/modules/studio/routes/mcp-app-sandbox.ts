import Router from '@koa/router'
import { serveMcpAppSandbox } from '../controllers/mcp-app-sandbox'

export const mcpAppSandboxRoutes = new Router()
mcpAppSandboxRoutes.get('/api/studio/mcp-apps/sandbox', serveMcpAppSandbox)
