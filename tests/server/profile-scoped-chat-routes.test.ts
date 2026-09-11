import { beforeEach, describe, expect, it, vi } from 'vitest'

const uploadControllers = vi.hoisted(() => ({
  handleUpload: vi.fn((ctx: any) => { ctx.body = { files: [] } }),
}))
const appUploadControllers = vi.hoisted(() => ({
  open: vi.fn((ctx: any) => { ctx.body = { upload: {} } }),
  appendChunk: vi.fn(),
  complete: vi.fn(),
  abort: vi.fn(),
}))
const mediaControllers = vi.hoisted(() => ({
  grokImageToVideo: vi.fn(),
  apiKeyImageGenerate: vi.fn((ctx: any) => { ctx.body = { images: [] } }),
  miniMaxImageToVideo: vi.fn(),
}))
const chatRunControllers = vi.hoisted(() => ({
  runOnce: vi.fn((ctx: any) => { ctx.body = { ok: true } }),
}))
const mcpControllers = vi.hoisted(() => ({
  listServers: vi.fn(),
  addServer: vi.fn(),
  updateServer: vi.fn(),
  removeServer: vi.fn(),
  testServer: vi.fn(),
  listTools: vi.fn(),
  reloadMcp: vi.fn(),
  resolveApp: vi.fn((ctx: any) => { ctx.body = { ok: true } }),
}))

vi.mock('../../packages/server/src/modules/studio/controllers/upload', () => uploadControllers)
vi.mock('../../packages/server/src/modules/studio/controllers/app-upload', () => appUploadControllers)
vi.mock('../../packages/server/src/modules/studio/controllers/media', () => mediaControllers)
vi.mock('../../packages/server/src/modules/studio/controllers/chat-run', () => chatRunControllers)
vi.mock('../../packages/server/src/modules/hermes/controllers/mcp', () => mcpControllers)

async function dispatch(layer: any, ctx: any): Promise<void> {
  const invoke = async (index: number): Promise<void> => {
    const handler = layer?.stack?.[index]
    if (!handler) return
    await handler(ctx, () => invoke(index + 1))
  }
  await invoke(0)
}

describe('Profile-scoped chat routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects ordinary chat operations without a validated Profile', async () => {
    const { uploadRoutes } = await import('../../packages/server/src/modules/studio/routes/upload')
    const { appUploadRoutes } = await import('../../packages/server/src/modules/studio/routes/app-upload')
    const { mediaRoutes } = await import('../../packages/server/src/modules/studio/routes/media')
    const { chatRunRoutes } = await import('../../packages/server/src/modules/studio/routes/chat-run')
    const cases = [
      [uploadRoutes, '/api/studio/uploads'],
      [appUploadRoutes, '/api/studio/app-uploads'],
      [mediaRoutes, '/api/studio/media/apikey-image-generate'],
      [chatRunRoutes, '/api/studio/chat-run/runs'],
    ] as const

    for (const [router, path] of cases) {
      const layer = router.stack.find((entry: any) => entry.path === path)
      const ctx: any = {
        state: { user: { id: 7, username: 'member', role: 'user' } },
        query: {},
        request: { body: {} },
        params: {},
        status: 200,
        body: null,
      }

      await dispatch(layer, ctx)

      expect(ctx.status, path).toBe(400)
      expect(ctx.body).toEqual({ error: 'Profile is required' })
    }
    expect(uploadControllers.handleUpload).not.toHaveBeenCalled()
    expect(appUploadControllers.open).not.toHaveBeenCalled()
    expect(mediaControllers.apiKeyImageGenerate).not.toHaveBeenCalled()
    expect(chatRunControllers.runOnce).not.toHaveBeenCalled()
  })

  it('rejects MCP App resolution without a validated Profile', async () => {
    const { mcpAppRoutes } = await import('../../packages/server/src/modules/hermes/routes/mcp')
    const layer = mcpAppRoutes.stack.find((entry: any) => entry.path === '/api/hermes/mcp/apps/resolve')
    const ctx: any = {
      state: { user: { id: 7, username: 'member', role: 'user' } },
      query: {},
      request: { body: { toolName: 'mcp__ticket__render' } },
      params: {},
      status: 200,
      body: null,
    }

    await dispatch(layer, ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'Profile is required' })
    expect(mcpControllers.resolveApp).not.toHaveBeenCalled()
  })

  it('allows the same chat operations with an authorized Profile', async () => {
    const { uploadRoutes } = await import('../../packages/server/src/modules/studio/routes/upload')
    const { chatRunRoutes } = await import('../../packages/server/src/modules/studio/routes/chat-run')
    const ctx = (): any => ({
      state: {
        user: { id: 7, username: 'member', role: 'user', profiles: ['research'] },
        profile: { name: 'research' },
      },
      query: {},
      request: { body: {} },
      params: {},
      status: 200,
      body: null,
    })
    const uploadCtx = ctx()
    const runCtx = ctx()

    await dispatch(uploadRoutes.stack.find((entry: any) => entry.path === '/api/studio/uploads'), uploadCtx)
    await dispatch(chatRunRoutes.stack.find((entry: any) => entry.path === '/api/studio/chat-run/runs'), runCtx)

    expect(uploadControllers.handleUpload).toHaveBeenCalledWith(uploadCtx, expect.any(Function))
    expect(chatRunControllers.runOnce).toHaveBeenCalledWith(runCtx, expect.any(Function))
  })
})
