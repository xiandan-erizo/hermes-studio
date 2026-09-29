export interface McpAppDiagnosticFields {
  instanceId?: string
  sessionId?: string
  toolCallId?: string
  draftId?: string
  version?: number
  displayMode?: string
  toolName?: string
  outcome?: string
  code?: string
  reason?: string
  status?: number
  hasEditAuthority?: boolean
}

const STRING_FIELDS = [
  'instanceId', 'sessionId', 'toolCallId', 'draftId', 'displayMode',
  'toolName', 'outcome', 'code', 'reason',
] as const

export function traceMcpApp(event: string, fields: McpAppDiagnosticFields): void {
  if (typeof window === 'undefined') return
  try {
    if (window.localStorage.getItem('hermes_mcp_app_debug') !== '1') return
  } catch { return }

  const entry: Record<string, string | number | boolean> = { event }
  for (const field of STRING_FIELDS) {
    const value = fields[field]
    if (typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)) entry[field] = value
  }
  for (const field of ['version', 'status'] as const) {
    const value = fields[field]
    if (typeof value === 'number' && Number.isSafeInteger(value)) entry[field] = value
  }
  if (typeof fields.hasEditAuthority === 'boolean') entry.hasEditAuthority = fields.hasEditAuthority
  console.debug('[MCP App Debug]', JSON.stringify(entry))
}
