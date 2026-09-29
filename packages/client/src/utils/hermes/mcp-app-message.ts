const MAX_MCP_APP_MESSAGE_CHARS = 4096

export function mcpAppUserMessage(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const value = input as { role?: unknown; content?: unknown }
  if (value.role !== 'user' || !Array.isArray(value.content) || value.content.length !== 1) return null
  const block = value.content[0]
  if (!block || typeof block !== 'object' || Array.isArray(block)) return null
  const content = block as { type?: unknown; text?: unknown }
  if (content.type !== 'text' || typeof content.text !== 'string') return null
  const text = content.text.trim()
  return text && text.length <= MAX_MCP_APP_MESSAGE_CHARS ? text : null
}
