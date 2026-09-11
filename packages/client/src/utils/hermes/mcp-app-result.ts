import type { CallToolResult } from '@modelcontextprotocol/client'
import type { Message } from '@/stores/hermes/chat'

export interface McpAppInvocation {
  toolName: string
  toolCallId?: string
  toolArgs: Record<string, unknown>
  toolResult: CallToolResult
}

const MAX_WRAPPER_DEPTH = 6
const MAX_JSON_CHARS = 2 * 1024 * 1024
const WRAPPER_KEYS = ['output', 'result', 'data'] as const

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string' || value.length > MAX_JSON_CHARS) return value
  try { return JSON.parse(value) } catch { return value }
}

function cloneJson<T>(value: T): T | null {
  try { return JSON.parse(JSON.stringify(value)) as T } catch { return null }
}

function textContent(value: unknown): Array<{ type: 'text'; text: string }> {
  if (typeof value === 'string') return value ? [{ type: 'text', text: value }] : []
  if (value === undefined || value === null) return []
  try { return [{ type: 'text', text: JSON.stringify(value) }] } catch { return [] }
}

function standardContent(value: unknown): CallToolResult['content'] | null {
  if (!Array.isArray(value)) return null
  const blocks = value.filter(item => record(item) && typeof record(item)?.type === 'string')
  return blocks.length === value.length ? blocks as CallToolResult['content'] : null
}

export function normalizeMcpCallToolResult(value: unknown): CallToolResult | null {
  const queue: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  for (let index = 0; index < queue.length && index < 32; index += 1) {
    const item = queue[index]
    if (item.depth > MAX_WRAPPER_DEPTH) continue
    const parsed = parseJson(item.value)
    const current = record(parsed)
    if (!current) continue

    const failed = current.ok === false
      || current.isError === true
      || (typeof current.exit_code === 'number' && current.exit_code !== 0)
    const structured = record(current.structuredContent)
    const content = standardContent(current.content)
      || textContent(current.result ?? current.text ?? current.error)

    if (structured || standardContent(current.content)) {
      return cloneJson({
        content,
        ...(structured ? { structuredContent: structured } : {}),
        ...(record(current._meta) ? { _meta: current._meta as Record<string, unknown> } : {}),
        ...(failed ? { isError: true } : {}),
      }) as CallToolResult | null
    }
    if (failed) {
      return cloneJson({ content, isError: true }) as CallToolResult | null
    }
    for (const key of WRAPPER_KEYS) {
      if (current[key] !== undefined) queue.push({ value: current[key], depth: item.depth + 1 })
    }
  }
  return null
}

function normalizeToolArgs(value: unknown): Record<string, unknown> {
  const parsed = record(parseJson(value)) || {}
  return cloneJson(parsed) || {}
}

function mcpAppInvocation(message: Message): McpAppInvocation | null {
  if (
    message.role !== 'tool'
    || message.toolStatus !== 'done'
    || !message.toolName?.startsWith('mcp__')
  ) return null
  const toolResult = normalizeMcpCallToolResult(message.toolResult ?? message.content)
  if (!toolResult || toolResult.isError || !record(toolResult.structuredContent)) return null
  return {
    toolName: message.toolName,
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    toolArgs: normalizeToolArgs(message.toolArgs),
    toolResult,
  }
}

/** Presentation rows are derived from persisted MCP calls and never enter model history. */
export function includeMcpAppResults(messages: Message[]): Message[] {
  return messages.flatMap(message => {
    const invocation = mcpAppInvocation(message)
    if (!invocation) return [message]
    return [message, {
      id: `mcp-app:${message.id}`,
      role: 'system',
      systemType: 'mcp-app',
      content: '',
      timestamp: message.timestamp,
      mcpApp: invocation,
    } satisfies Message]
  })
}

function cspSource(value: unknown, protocols: string[]): string | null {
  if (typeof value !== 'string' || !value || /[\s;'"\\]/.test(value)) return null
  const wildcard = value.match(/^(https?|wss?):\/\/\*\.([A-Za-z0-9.-]+)(?::([0-9]+))?$/)
  if (wildcard) {
    if (!protocols.includes(`${wildcard[1]}:`) || !wildcard[2].includes('.')) return null
    return value
  }
  try {
    const url = new URL(value)
    if (!protocols.includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
    return url.origin
  } catch {
    return null
  }
}

function cspSources(value: unknown, protocols: string[]): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(item => cspSource(item, protocols)).filter((item): item is string => !!item))]
}

function directive(name: string, sources: string[]): string {
  return `${name} ${sources.length ? sources.join(' ') : "'none'"}`
}

export function buildMcpAppSrcdoc(html: string, metadata: Record<string, unknown> = {}): string {
  const document = new DOMParser().parseFromString(html, 'text/html')
  document.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]').forEach(node => node.remove())
  const ui = record(metadata.ui)
  const csp = record(ui?.csp)
  const resources = cspSources(csp?.resourceDomains, ['http:', 'https:'])
  const connections = cspSources(csp?.connectDomains, ['http:', 'https:', 'ws:', 'wss:'])
  const frames = cspSources(csp?.frameDomains, ['http:', 'https:'])
  const bases = cspSources(csp?.baseUriDomains, ['http:', 'https:'])
  const policy = [
    "default-src 'none'",
    directive('script-src', ["'unsafe-inline'", ...resources]),
    directive('style-src', ["'unsafe-inline'", ...resources]),
    directive('img-src', ['data:', 'blob:', ...resources]),
    directive('font-src', resources),
    directive('media-src', resources),
    directive('connect-src', connections),
    directive('frame-src', frames),
    directive('base-uri', bases),
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ')
  const meta = document.createElement('meta')
  meta.setAttribute('http-equiv', 'Content-Security-Policy')
  meta.setAttribute('content', policy)
  document.head.prepend(meta)
  return `<!doctype html>\n${document.documentElement.outerHTML}`
}

export function safeMcpAppExternalUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value || /[\s\\<>"\x00-\x1f\x7f]/.test(value)) return null
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}
