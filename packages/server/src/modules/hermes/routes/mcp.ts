import Router from '@koa/router'
import * as ctrl from '../controllers/mcp'
import { callAppTool, updateAppModelContext } from '../controllers/mcp-app-interactions'
import { requireScopedProfile } from '../../studio/public/auth'

export const mcpRoutes = new Router()
export const mcpAppRoutes = new Router()

mcpAppRoutes.post('/api/hermes/mcp/apps/resolve', requireScopedProfile, ctrl.resolveApp)
mcpAppRoutes.post('/api/hermes/mcp/apps/call-tool', requireScopedProfile, callAppTool)
mcpAppRoutes.post('/api/hermes/mcp/apps/model-context', requireScopedProfile, updateAppModelContext)

mcpRoutes.get('/api/hermes/mcp/servers', ctrl.listServers)
mcpRoutes.post('/api/hermes/mcp/servers', ctrl.addServer)
mcpRoutes.patch('/api/hermes/mcp/servers/:name', ctrl.updateServer)
mcpRoutes.delete('/api/hermes/mcp/servers/:name', ctrl.removeServer)
mcpRoutes.post('/api/hermes/mcp/servers/:name/test', ctrl.testServer)
mcpRoutes.get('/api/hermes/mcp/tools', ctrl.listTools)
mcpRoutes.post('/api/hermes/mcp/reload', ctrl.reloadMcp)
