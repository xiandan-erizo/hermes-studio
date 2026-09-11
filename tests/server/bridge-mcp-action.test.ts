import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mocks ──────────────────────────────────────────────────
const mcpToolsMock = vi.fn()
const mcpAppResolveMock = vi.fn()
const mcpPortableReloadMock = vi.fn()

vi.mock('../../packages/server/src/modules/hermes/services/bridge/client', () => ({
  AgentBridgeClient: vi.fn().mockImplementation(() => ({
    mcpTools: mcpToolsMock,
    mcpAppResolve: mcpAppResolveMock,
    mcpPortableReload: mcpPortableReloadMock,
  })),
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

// ── Tests ──────────────────────────────────────────────────
describe('bridgeMcpAction - mcp_tools_list', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('passes server and profile to client.mcpTools', async () => {
    mcpToolsMock.mockResolvedValue({ ok: true, results: [] })
    const { bridgeMcpAction } = await import('../../packages/server/src/modules/hermes/services/mcp/bridge-actions')
    await bridgeMcpAction('mcp_tools_list', { server: 'github' }, 'test-profile')
    expect(mcpToolsMock).toHaveBeenCalledWith('github', 'test-profile', undefined)
  })

  it('passes raw=true to client.mcpTools', async () => {
    mcpToolsMock.mockResolvedValue({ ok: true, results: [] })
    const { bridgeMcpAction } = await import('../../packages/server/src/modules/hermes/services/mcp/bridge-actions')
    await bridgeMcpAction('mcp_tools_list', { server: 'github', raw: true }, 'test-profile')
    expect(mcpToolsMock).toHaveBeenCalledWith('github', 'test-profile', true)
  })

  it('passes raw=false to client.mcpTools', async () => {
    mcpToolsMock.mockResolvedValue({ ok: true, results: [] })
    const { bridgeMcpAction } = await import('../../packages/server/src/modules/hermes/services/mcp/bridge-actions')
    await bridgeMcpAction('mcp_tools_list', { server: 'github', raw: false }, 'test-profile')
    expect(mcpToolsMock).toHaveBeenCalledWith('github', 'test-profile', false)
  })

  it('passes undefined server when not provided', async () => {
    mcpToolsMock.mockResolvedValue({ ok: true, results: [] })
    const { bridgeMcpAction } = await import('../../packages/server/src/modules/hermes/services/mcp/bridge-actions')
    await bridgeMcpAction('mcp_tools_list', {}, 'test-profile')
    expect(mcpToolsMock).toHaveBeenCalledWith(undefined, 'test-profile', undefined)
  })

  it('passes undefined profile when not provided', async () => {
    mcpToolsMock.mockResolvedValue({ ok: true, results: [] })
    const { bridgeMcpAction } = await import('../../packages/server/src/modules/hermes/services/mcp/bridge-actions')
    await bridgeMcpAction('mcp_tools_list', { server: 'github' })
    expect(mcpToolsMock).toHaveBeenCalledWith('github', undefined, undefined)
  })
})

describe('bridgeMcpAction - mcp_app_resolve', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('passes the registered tool name and profile to the bridge client', async () => {
    mcpAppResolveMock.mockResolvedValue({ ok: true, resource: { text: '<html></html>' } })
    const { bridgeMcpAction } = await import('../../packages/server/src/modules/hermes/services/mcp/bridge-actions')
    await bridgeMcpAction('mcp_app_resolve', { toolName: 'mcp__ticket__render' }, 'research')
    expect(mcpAppResolveMock).toHaveBeenCalledWith('mcp__ticket__render', 'research')
  })
})

describe('bridgeMcpAction - mcp_portable_reload', () => {
  it('reloads portable MCP packages in the selected profile', async () => {
    mcpPortableReloadMock.mockResolvedValue({ ok: true, servers: ['ticket-view'] })
    const { bridgeMcpAction } = await import('../../packages/server/src/modules/hermes/services/mcp/bridge-actions')
    await bridgeMcpAction('mcp_portable_reload', {}, 'research')
    expect(mcpPortableReloadMock).toHaveBeenCalledWith('research')
  })
})
