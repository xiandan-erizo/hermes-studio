export function buildSandboxUrl(parentOrigin: string, configuredOrigin: string | undefined, resourceMeta: Record<string, unknown>): string {
  const parent = new URL(parentOrigin)
  let origin = configuredOrigin
  if (!origin && ['127.0.0.1', 'localhost'].includes(parent.hostname)) {
    const loopback = new URL(parent.origin)
    loopback.hostname = parent.hostname === 'localhost' ? '127.0.0.1' : 'localhost'
    origin = loopback.origin
  }
  if (!origin) throw new Error('A separate MCP App sandbox origin must be configured')
  const sandbox = new URL(origin)
  if (!['http:', 'https:'].includes(sandbox.protocol) || sandbox.username || sandbox.password
    || sandbox.pathname !== '/' || sandbox.search || sandbox.hash || sandbox.origin === parent.origin
    || (parent.protocol === 'https:' && sandbox.protocol !== 'https:')) {
    throw new Error('MCP App sandbox must use a separate, secure origin')
  }
  const ui = resourceMeta.ui as { csp?: Record<string, unknown> } | undefined
  sandbox.pathname = '/api/studio/mcp-apps/sandbox'
  sandbox.searchParams.set('parentOrigin', parent.origin)
  sandbox.searchParams.set('csp', JSON.stringify(ui?.csp || {}))
  return sandbox.href
}

export function mcpAppStyleVariables(isDark: boolean): Record<string, string> {
  const css = getComputedStyle(document.documentElement)
  const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback
  return {
    '--color-background-primary': token('--bg-main', isDark ? '#181818' : '#ffffff'),
    '--color-background-secondary': token('--bg-secondary', isDark ? '#242424' : '#f7f7f8'),
    '--color-background-tertiary': isDark ? '#303030' : '#f0f0f2',
    '--color-text-primary': token('--text-primary', isDark ? '#eeeeee' : '#202123'),
    '--color-text-secondary': token('--text-secondary', isDark ? '#aaa' : '#6b6b70'),
    '--color-text-tertiary': isDark ? '#85858b' : '#8e8e93',
    '--color-border-primary': token('--border-color', isDark ? '#383838' : '#e8e8eb'),
    '--color-background-success': isDark ? '#1a3027' : '#edf7f1',
    '--color-text-success': isDark ? '#85c6a5' : '#347958',
    '--color-background-warning': isDark ? '#332d20' : '#fbf7ec',
    '--color-text-warning': isDark ? '#d8bd7b' : '#8b713a',
    '--font-sans': 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
    '--font-text-sm-size': '13px', '--font-text-md-size': '14px', '--font-heading-sm-size': '18px',
    '--border-radius-md': '12px', '--border-radius-lg': '16px',
  }
}
