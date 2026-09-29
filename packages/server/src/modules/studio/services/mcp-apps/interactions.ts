import { getSession, getSessionDetail } from '../../repositories/session-store'
import { McpUiMessageRequestSchema, McpUiUpdateModelContextRequestSchema } from '@modelcontextprotocol/ext-apps/app-bridge'
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

function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string' || value.length > 2 * 1024 * 1024) return value
  try { return JSON.parse(value) } catch { return value }
}

function versionedDraft(value: unknown, depth = 0): { id: string; version: number; envelope: Record<string, unknown> } | null {
  if (depth > 6) return null
  const parsed = jsonValue(value)
  if (!object(parsed)) return null
  if (typeof parsed.draft_id === 'string' && Number.isInteger(parsed.version)) {
    return { id: parsed.draft_id, version: Number(parsed.version), envelope: parsed }
  }
  const draft = object(parsed.draft) ? parsed.draft : null
  if (draft && typeof draft.draft_id === 'string' && Number.isInteger(draft.version)) {
    return { id: draft.draft_id, version: Number(draft.version), envelope: parsed }
  }
  for (const key of ['data', 'result', 'output']) {
    const nested = versionedDraft(parsed[key], depth + 1)
    if (nested) return nested
  }
  return null
}

function invocationArguments(detail: ReturnType<typeof getSessionDetail>, binding: McpAppBinding): Record<string, unknown> | null {
  const assistant = detail?.messages.find(message => (
    message.role === 'assistant'
    && Array.isArray(message.tool_calls)
    && message.tool_calls.some((call: any) => String(call?.id || '') === binding.toolCallId)
  ))
  const call = assistant?.tool_calls?.find((item: any) => String(item?.id || '') === binding.toolCallId) as any
  const args = call?.function?.arguments
  const parsed = jsonValue(args)
  return object(parsed) ? parsed : null
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
  const detail = getSessionDetail(binding.sessionId)
  const matches = detail?.messages.filter(message => (
    message.role === 'tool' && message.tool_call_id === binding.toolCallId && message.tool_name === binding.toolName
  )) || []
  if (!binding.toolName.startsWith('mcp__')) {
    throw interactionError('App invocation is not available', 404)
  }
  if (matches.length === 1 && successfulToolResult(matches[0].content)) return binding

  // A resumed or duplicated App can retain an older toolCallId after the
  // model produced another renderer result. Keep the binding session-scoped,
  // but move it to the newest successful call for the same draft. This avoids
  // transient 404s without allowing a card to cross session/profile ownership.
  const requestedDraftId = versionedDraft(invocationArguments(detail, binding)?.result)?.id
  if (requestedDraftId && detail) {
    const fallback = detail.messages
      .filter(message => (
        message.role === 'tool'
        && message.tool_name === binding.toolName
        && successfulToolResult(message.content)
      ))
      .map(message => {
        const candidateBinding = { ...binding, toolCallId: String(message.tool_call_id || '') }
        const candidateDraftId = versionedDraft(invocationArguments(detail, candidateBinding)?.result)?.id
        return { message, candidateDraftId }
      })
      .filter(candidate => candidate.candidateDraftId === requestedDraftId)
      .sort((a, b) => Number(b.message.id) - Number(a.message.id))[0]
    if (fallback?.message.tool_call_id) {
      return { ...binding, toolCallId: String(fallback.message.tool_call_id) }
    }
  }
  throw interactionError('App invocation is not available', 404)
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

export function validateMcpAppMessage(input: unknown): string {
  const parsed = McpUiMessageRequestSchema.shape.params.safeParse(input)
  if (!parsed.success || parsed.data.role !== 'user' || parsed.data.content.length !== 1) {
    throw interactionError('Invalid App message')
  }
  const block = parsed.data.content[0]
  if (block.type !== 'text') throw interactionError('Only one text App message is supported')
  const message = block.text.trim()
  if (!message || message.length > 4096) throw interactionError('App message exceeds 4096 characters', 413)
  return message
}
