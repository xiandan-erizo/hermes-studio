/**
 * Channel-session refresh — keeps imported channel conversations (feishu,
 * dingtalk, ...) in sync with the agent's state.db so a conversation started
 * on a channel can be continued in the Web UI with full context.
 *
 * state.db is authoritative for channel sessions: every turn — whether it
 * arrives via the channel bridge or via a Web UI run — is persisted there by
 * the agent. The local Web UI copy is an import snapshot; this service detects
 * drift (state.db row count differs from the local row count) and rebuilds
 * the local message copy plus the session metadata.
 */

import { addMessages, clearSessionMessages, getMessageCount, getSession, updateSession, updateSessionStats } from '../repositories/session-store'
import { isChannelSource } from '../repositories/external-identities-store'
import { getHermesSessionDetailForProfile, getHermesSessionMessageCountForProfile } from '../public/session-agent-runtime'
import { logger } from '../public/logging'

export interface LocalImportMessage {
  session_id: string
  role: string
  content: string
  tool_call_id?: string | null
  tool_calls?: any[] | null
  tool_name?: string | null
  timestamp?: number
  token_count?: number | null
  finish_reason?: string | null
  reasoning?: string | null
  reasoning_details?: string | null
  reasoning_content?: string | null
}

export function normalizeImportText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function normalizeImportNullableText(value: unknown): string | null {
  const text = normalizeImportText(value)
  return text ? text : null
}

export function normalizeImportToolCalls(value: unknown): any[] | null {
  if (!Array.isArray(value)) return null
  const calls = value
    .map((call: any) => {
      const id = String(call?.id || '').trim()
      const fn = call?.function && typeof call.function === 'object' ? call.function : {}
      const name = String(fn.name || call?.name || '').trim()
      if (!id || !name) return null
      const rawArgs = fn.arguments ?? call?.arguments ?? {}
      const args = typeof rawArgs === 'string' ? rawArgs : normalizeImportText(rawArgs || {})
      return {
        id,
        type: String(call?.type || 'function'),
        function: { name, arguments: args || '{}' },
      }
    })
    .filter((call): call is { id: string; type: string; function: { name: string; arguments: string } } => Boolean(call))
  return calls.length > 0 ? calls : null
}

export function buildImportMessages(sessionId: string, messages: any[]): LocalImportMessage[] {
  const result: LocalImportMessage[] = []
  const knownToolCallIds = new Set<string>()

  for (const message of messages) {
    const role = String(message?.role || '').trim()
    if (role !== 'user' && role !== 'assistant' && role !== 'tool') continue

    const toolCalls = role === 'assistant' ? normalizeImportToolCalls(message.tool_calls) : null
    if (toolCalls) {
      for (const call of toolCalls) knownToolCallIds.add(call.id)
    }

    if (role === 'tool') {
      const callId = String(message?.tool_call_id || '').trim()
      if (!callId || !knownToolCallIds.has(callId)) continue
      result.push({
        session_id: sessionId,
        role,
        content: normalizeImportText(message?.content),
        tool_call_id: callId,
        tool_calls: null,
        tool_name: normalizeImportNullableText(message?.tool_name),
        timestamp: Number(message?.timestamp || 0),
        token_count: message?.token_count == null ? null : Number(message.token_count),
        finish_reason: normalizeImportNullableText(message?.finish_reason),
        reasoning: null,
        reasoning_details: null,
        reasoning_content: null,
      })
      continue
    }

    const content = normalizeImportText(message?.content)
    if (role === 'assistant' && !content.trim() && !toolCalls) continue

    result.push({
      session_id: sessionId,
      role,
      content,
      tool_call_id: null,
      tool_calls: toolCalls,
      tool_name: null,
      timestamp: Number(message?.timestamp || 0),
      token_count: message?.token_count == null ? null : Number(message.token_count),
      finish_reason: normalizeImportNullableText(message?.finish_reason),
      reasoning: role === 'assistant' ? normalizeImportNullableText(message?.reasoning) : null,
      reasoning_details: role === 'assistant' ? normalizeImportNullableText(message?.reasoning_details) : null,
      reasoning_content: role === 'assistant' ? normalizeImportNullableText(message?.reasoning_content) : null,
    })
  }

  return result
}

/**
 * Rebuild the local copy of a channel session from Hermes state.db when the
 * agent-side message count has drifted from the local one. Returns true when a
 * refresh was performed. Non-channel sessions and missing sessions are no-ops.
 */
export async function refreshChannelSessionFromHermes(sessionId: string, profile: string): Promise<boolean> {
  const local = getSession(sessionId)
  if (!local || !isChannelSource(String(local.source || ''))) return false

  const profileName = profile || 'default'

  let stateCount: number | null = null
  try {
    stateCount = await getHermesSessionMessageCountForProfile(sessionId, profileName)
  } catch (err) {
    logger.warn({ err, sessionId, profile: profileName }, 'Hermes Session: channel refresh count failed')
    return false
  }
  if (stateCount == null) return false

  const localCount = getMessageCount(sessionId)
  if (stateCount === localCount) return false

  let detail: any = null
  try {
    detail = await getHermesSessionDetailForProfile(sessionId, profileName)
  } catch (err) {
    logger.warn({ err, sessionId, profile: profileName }, 'Hermes Session: channel refresh detail failed')
    return false
  }
  if (!detail) return false

  clearSessionMessages(sessionId)
  addMessages(buildImportMessages(sessionId, Array.isArray(detail.messages) ? detail.messages : []))
  const metadata: Record<string, unknown> = {
    source: detail.source || local.source,
    user_id: detail.user_id,
    title: detail.title,
    ended_at: detail.ended_at,
    end_reason: detail.end_reason,
    tool_call_count: detail.tool_call_count,
    input_tokens: detail.input_tokens,
    output_tokens: detail.output_tokens,
    cache_read_tokens: detail.cache_read_tokens,
    cache_write_tokens: detail.cache_write_tokens,
    reasoning_tokens: detail.reasoning_tokens,
    billing_provider: detail.billing_provider,
    estimated_cost_usd: detail.estimated_cost_usd,
    actual_cost_usd: detail.actual_cost_usd,
    cost_status: detail.cost_status,
    preview: detail.preview,
    last_active: detail.last_active,
  }
  for (const key of Object.keys(metadata)) {
    if (metadata[key] === undefined) delete metadata[key]
  }
  updateSession(sessionId, metadata)
  updateSessionStats(sessionId)

  logger.info({ sessionId, profile: profileName, stateCount, localCount }, '[channel-refresh] rebuilt local channel session from Hermes state')
  return true
}
