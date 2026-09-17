import { getSession, getSessionDetail } from '../../repositories/session-store'
import { McpUiUpdateModelContextRequestSchema } from '@modelcontextprotocol/ext-apps/app-bridge'
import { canOperateSession, type SessionAccessUser } from '../session-access'

export interface McpAppBinding {
  sessionId: string
  toolCallId: string
  toolName: string
}

export function interactionError(message: string, status = 400): Error {
  return Object.assign(new Error(message), { status })
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function successfulToolResult(text: string): boolean {
  try {
    let value: unknown = JSON.parse(text)
    for (let depth = 0; depth < 6 && object(value); depth++) {
      if (value.isError === true || value.ok === false || value.error) return false
      if (Array.isArray(value.content) || object(value.structuredContent)) return true
      const next: unknown = value.result ?? value.output ?? value.data
      if (typeof next === 'string') {
        try { value = JSON.parse(next) } catch { return true }
      } else value = next
    }
  } catch { /* Malformed or truncated history cannot authorize new calls. */ }
  return false
}

/** Bind interactions to existing server-side evidence, never a browser-supplied transcript. */
export function requireMcpAppInvocation(user: SessionAccessUser | undefined, profile: string | undefined, input: unknown): McpAppBinding {
  if (!object(input)) throw interactionError('App invocation is required')
  const { sessionId, toolCallId, toolName } = input
  if (![sessionId, toolCallId, toolName].every(value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value))) {
    throw interactionError('Valid sessionId, toolCallId and toolName are required')
  }
  const binding = { sessionId, toolCallId, toolName } as McpAppBinding
  const session = getSession(binding.sessionId)
  if (!session || session.profile !== profile || !canOperateSession(user, session)) {
    throw interactionError('Session is not available', 404)
  }
  const matches = getSessionDetail(binding.sessionId)?.messages.filter(message => (
    message.role === 'tool' && message.tool_call_id === binding.toolCallId && message.tool_name === binding.toolName
  )) || []
  if (!binding.toolName.startsWith('mcp__') || matches.length !== 1 || !successfulToolResult(matches[0].content)) {
    throw interactionError('App invocation is not available', 404)
  }
  return binding
}

export function validateModelContext(input: unknown): { content?: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown> } {
  if (!object(input) || Object.keys(input).some(key => !['content', 'structuredContent'].includes(key))) throw interactionError('Invalid model context')
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 8192) throw interactionError('Model context exceeds 8 KiB', 413)
  const parsed = McpUiUpdateModelContextRequestSchema.shape.params.safeParse(input)
  if (!parsed.success) throw interactionError('Invalid model context')
  if (parsed.data.content?.some(item => item.type !== 'text')) {
    throw interactionError('Only text model context is supported')
  }
  return parsed.data as ReturnType<typeof validateModelContext>
}
