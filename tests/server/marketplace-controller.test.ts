import { beforeEach, describe, expect, it, vi } from 'vitest'

const readPluginDetailMock = vi.fn()
const installMarketplacePluginMock = vi.fn()
const installMarketplaceSkillMock = vi.fn()
const uninstallMarketplaceSkillMock = vi.fn()
const syncSourceMock = vi.fn()
const bridgeMcpActionMock = vi.fn()

const source = {
  id: 7,
  name: 'hose-skills',
  url: 'git@git.ekuaibao.com:ai-learning/hose-skills.git',
  enabled: 1,
  last_synced_at: null,
  last_commit: null,
  last_error: null,
}

vi.mock('../../packages/server/src/modules/hermes/services/profiles/profile', () => ({
  getActiveProfileName: () => 'research',
  getProfileDir: (profile: string) => `/profiles/${profile}`,
}))

vi.mock('../../packages/server/src/modules/hermes/services/marketplace/sources-store', () => ({
  findMarketplaceSource: () => source,
  listMarketplaceSources: () => [source],
  recordSourceSync: vi.fn(),
  createMarketplaceSource: vi.fn(),
  deleteMarketplaceSource: vi.fn(),
  updateMarketplaceSource: vi.fn(),
  MarketplaceSourceConflictError: class extends Error {},
  MarketplaceSourceValidationError: class extends Error {},
}))

vi.mock('../../packages/server/src/modules/hermes/services/marketplace/git-cache', () => ({
  cachedCommit: vi.fn(),
  marketplaceCacheDir: () => '/cache/source-7',
  removeCache: vi.fn(),
  syncSource: syncSourceMock,
  validateGitSshUrl: vi.fn(),
  MarketplaceGitError: class extends Error {},
  MarketplaceUrlError: class extends Error {},
}))

vi.mock('../../packages/server/src/modules/hermes/services/marketplace/repo-scanner', () => ({
  readPluginDetail: readPluginDetailMock,
  scanMarketplaceRepo: vi.fn(),
  MarketplaceParseError: class extends Error {},
}))

vi.mock('../../packages/server/src/modules/hermes/services/marketplace/install', () => ({
  installMarketplacePlugin: installMarketplacePluginMock,
  installMarketplaceSkill: installMarketplaceSkillMock,
  listMarketplaceInstalled: vi.fn(),
  uninstallMarketplaceSkill: uninstallMarketplaceSkillMock,
  MarketplaceInstallError: class extends Error {
    status = 400
  },
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../packages/server/src/modules/hermes/services/mcp/bridge-actions', () => ({
  bridgeMcpAction: bridgeMcpActionMock,
}))

function context(body: Record<string, unknown>) {
  return {
    state: { profile: { name: 'research' } },
    request: { body },
    params: {},
    status: 200,
    body: null as unknown,
  }
}

describe('Marketplace install controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    syncSourceMock.mockResolvedValue({ commit: 'abc123' })
    installMarketplacePluginMock.mockResolvedValue({
      plugin: 'ticket-intake', skill: 'ticket-intake', installKind: 'plugin', updated: false,
    })
    installMarketplaceSkillMock.mockResolvedValue({
      plugin: 'legacy', skill: 'legacy-skill', installKind: 'skill', updated: false,
    })
    bridgeMcpActionMock.mockResolvedValue({ ok: true, servers: ['ticket-view'] })
  })

  it('installs a portable package without requiring a skill name', async () => {
    readPluginDetailMock.mockResolvedValue({ name: 'ticket-intake', version: '4.0.0', portable: true, skills: [] })
    const { install } = await import('../../packages/server/src/modules/hermes/controllers/marketplace')
    const ctx = context({ sourceId: 7, plugin: 'ticket-intake' })

    await install(ctx)

    expect(installMarketplacePluginMock).toHaveBeenCalledWith({
      source,
      repoDir: '/cache/source-7',
      profileDir: '/profiles/research',
      plugin: 'ticket-intake',
      version: '4.0.0',
    })
    expect(installMarketplaceSkillMock).not.toHaveBeenCalled()
    expect(bridgeMcpActionMock).toHaveBeenCalledWith('mcp_portable_reload', {}, 'research')
  })

  it('keeps a skill name mandatory for legacy packages', async () => {
    readPluginDetailMock.mockResolvedValue({ name: 'legacy', version: '1.0.0', portable: false, skills: [] })
    const { install } = await import('../../packages/server/src/modules/hermes/controllers/marketplace')
    const missing = context({ sourceId: 7, plugin: 'legacy' })
    await install(missing)
    expect(missing.status).toBe(400)

    const valid = context({ sourceId: 7, plugin: 'legacy', skill: 'legacy-skill' })
    await install(valid)
    expect(installMarketplaceSkillMock).toHaveBeenCalledWith(expect.objectContaining({
      plugin: 'legacy', skill: 'legacy-skill', skillsDir: '/profiles/research/skills',
    }))
    expect(installMarketplacePluginMock).not.toHaveBeenCalled()
    expect(bridgeMcpActionMock).not.toHaveBeenCalled()
  })

  it('keeps a completed install successful when immediate runtime reload is unavailable', async () => {
    readPluginDetailMock.mockResolvedValue({ name: 'ticket-intake', version: '4.0.0', portable: true, skills: [] })
    bridgeMcpActionMock.mockRejectedValue(new Error('bridge offline'))
    const { install } = await import('../../packages/server/src/modules/hermes/controllers/marketplace')
    const ctx = context({ sourceId: 7, plugin: 'ticket-intake' })

    await install(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toMatchObject({ success: true, reloadError: 'bridge offline' })
  })

  it('reloads portable MCP runtime after uninstall but leaves legacy skill removal alone', async () => {
    const { uninstall } = await import('../../packages/server/src/modules/hermes/controllers/marketplace')
    uninstallMarketplaceSkillMock.mockResolvedValueOnce({
      installKind: 'plugin', plugin: 'ticket-intake', skill: 'ticket-intake',
    })
    const portable = { ...context({}), params: { skill: 'ticket-intake' } }
    await uninstall(portable)
    expect(bridgeMcpActionMock).toHaveBeenCalledWith('mcp_portable_reload', {}, 'research')
    expect(portable.body).toEqual({ success: true })

    vi.clearAllMocks()
    uninstallMarketplaceSkillMock.mockResolvedValueOnce({
      installKind: 'skill', plugin: 'legacy', skill: 'legacy-child',
    })
    const legacy = { ...context({}), params: { skill: 'legacy-child' } }
    await uninstall(legacy)
    expect(bridgeMcpActionMock).not.toHaveBeenCalled()
    expect(legacy.body).toEqual({ success: true })
  })
})
