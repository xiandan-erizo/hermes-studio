import type { Context } from 'koa'
import { getBridgeClient, bridgeMcpAction } from '../services/mcp/bridge-actions'
import { interactionError, requireMcpAppInvocation, saveMcpAppContext, validateModelContext } from '../../studio/public/mcp-apps'

function fail(ctx: Context, error: unknown): void {
  const err = error as { status?: number; response?: { code?: string }; message?: string }
  const code = err.response?.code
  ctx.status = err.status || (code === 'mcp_app_not_found' ? 404 : code === 'mcp_app_tool_forbidden' ? 403 : 503)
  ctx.body = { error: err.status ? err.message : 'MCP App interaction failed', ...(code ? { code } : {}) }
}

export async function callAppTool(ctx: Context): Promise<void> {
  try {
    const body = (ctx.request.body || {}) as Record<string, unknown>
    const profile = ctx.state.profile?.name
    const binding = requireMcpAppInvocation(ctx.state.user, profile, body)
    const params = body.params as Record<string, unknown> | undefined
    if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => !['name', 'arguments'].includes(key))
      || typeof params.name !== 'string' || !params.name || params.name.length > 256
      || (params.arguments !== undefined && (!params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments)))) {
      throw interactionError('Invalid tools/call parameters')
    }
    if (Buffer.byteLength(JSON.stringify(params), 'utf8') > 262144) throw interactionError('App tool call exceeds 256 KiB', 413)
    const response = await getBridgeClient().mcpAppCallTool(binding.toolName, params.name, (params.arguments || {}) as Record<string, unknown>, profile!)
    ctx.body = response.result
  } catch (error) { fail(ctx, error) }
}

export async function updateAppModelContext(ctx: Context): Promise<void> {
  try {
    const body = (ctx.request.body || {}) as Record<string, unknown>
    const profile = ctx.state.profile?.name
    const binding = requireMcpAppInvocation(ctx.state.user, profile, body)
    const context = validateModelContext(body.params)
    // Confirm this recorded tool still declares an App in the authorized profile.
    await bridgeMcpAction('mcp_app_resolve', { toolName: binding.toolName }, profile)
    saveMcpAppContext(profile!, binding, context)
    ctx.body = {}
  } catch (error) { fail(ctx, error) }
}
