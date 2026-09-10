import { beforeEach, describe, expect, it, vi } from 'vitest'

const ttsControllers = vi.hoisted(() => ({
  listSettings: vi.fn(),
  synthesizeVoiceProxy: vi.fn(),
  synthesizeVoiceProxyOpenAi: vi.fn(),
  saveActiveProvider: vi.fn((ctx: any) => { ctx.body = { ok: true } }),
  saveSettings: vi.fn((ctx: any) => { ctx.body = { ok: true } }),
  deleteProvider: vi.fn((ctx: any) => { ctx.body = { ok: true } }),
  deleteBaseUrlPreset: vi.fn((ctx: any) => { ctx.body = { ok: true } }),
  deleteSecret: vi.fn((ctx: any) => { ctx.body = { ok: true } }),
  probeProvider: vi.fn((ctx: any) => { ctx.body = { ok: true } }),
  synthesize: vi.fn(),
  generate: vi.fn(),
  openaiProxy: vi.fn(),
  mcuAudio: vi.fn(),
}))
const sttControllers = vi.hoisted(() => ({
  listSettings: vi.fn(),
  transcribeVoiceProxy: vi.fn(),
  profileStatus: vi.fn(),
  missingProfileAudio: vi.fn(),
  mcuVoiceTurn: vi.fn(),
  saveActiveProvider: vi.fn((ctx: any) => { ctx.body = { ok: true } }),
  saveSettings: vi.fn((ctx: any) => { ctx.body = { ok: true } }),
  deleteProvider: vi.fn((ctx: any) => { ctx.body = { ok: true } }),
  deleteBaseUrlPreset: vi.fn((ctx: any) => { ctx.body = { ok: true } }),
  deleteSecret: vi.fn((ctx: any) => { ctx.body = { ok: true } }),
  startLocalStream: vi.fn(),
  pushLocalStreamChunk: vi.fn(),
  finishLocalStream: vi.fn(),
  cancelLocalStream: vi.fn(),
  transcribe: vi.fn(),
}))
const localModelControllers = vi.hoisted(() => ({
  status: vi.fn(),
  download: vi.fn((ctx: any) => { ctx.body = { ok: true } }),
}))

vi.mock('../../packages/server/src/modules/studio/controllers/tts', () => ttsControllers)
vi.mock('../../packages/server/src/modules/studio/controllers/stt', () => sttControllers)
vi.mock('../../packages/server/src/modules/studio/controllers/local-stt-model', () => localModelControllers)

async function dispatch(layer: any, ctx: any): Promise<void> {
  const invoke = async (index: number): Promise<void> => {
    const handler = layer?.stack?.[index]
    if (!handler) return
    await handler(ctx, () => invoke(index + 1))
  }
  await invoke(0)
}

describe('voice route permissions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('blocks plain users from voice provider mutations and local model downloads', async () => {
    const { ttsProtectedRoutes } = await import('../../packages/server/src/modules/studio/routes/tts')
    const { sttProtectedRoutes } = await import('../../packages/server/src/modules/studio/routes/stt')
    const cases = [
      [ttsProtectedRoutes, 'PUT', '/api/studio/tts/settings/active'],
      [ttsProtectedRoutes, 'DELETE', '/api/studio/tts/settings/:provider'],
      [ttsProtectedRoutes, 'POST', '/api/voice/providers/probe'],
      [sttProtectedRoutes, 'POST', '/api/studio/stt/local-model/download'],
      [sttProtectedRoutes, 'PUT', '/api/studio/stt/settings/active'],
      [sttProtectedRoutes, 'DELETE', '/api/studio/stt/settings/:provider'],
    ] as const

    for (const [router, method, path] of cases) {
      const layer = router.stack.find((entry: any) => entry.path === path && entry.methods.includes(method))
      const ctx: any = {
        state: { user: { id: 7, username: 'member', role: 'user' }, profile: { name: 'default' } },
        query: {},
        request: { body: {} },
        params: { provider: 'openai' },
        status: 200,
        body: null,
      }

      await dispatch(layer, ctx)

      expect(ctx.status, `${method} ${path}`).toBe(403)
      expect(ctx.body).toEqual({ error: 'Administrator privileges are required' })
    }
    expect(ttsControllers.saveActiveProvider).not.toHaveBeenCalled()
    expect(ttsControllers.deleteProvider).not.toHaveBeenCalled()
    expect(ttsControllers.probeProvider).not.toHaveBeenCalled()
    expect(localModelControllers.download).not.toHaveBeenCalled()
    expect(sttControllers.saveActiveProvider).not.toHaveBeenCalled()
    expect(sttControllers.deleteProvider).not.toHaveBeenCalled()
  })

  it('allows administrators to manage voice providers and local speech models', async () => {
    const { ttsProtectedRoutes } = await import('../../packages/server/src/modules/studio/routes/tts')
    const { sttProtectedRoutes } = await import('../../packages/server/src/modules/studio/routes/stt')
    const ttsLayer = ttsProtectedRoutes.stack.find((entry: any) => (
      entry.path === '/api/studio/tts/settings/active' && entry.methods.includes('PUT')
    ))
    const sttLayer = sttProtectedRoutes.stack.find((entry: any) => (
      entry.path === '/api/studio/stt/local-model/download' && entry.methods.includes('POST')
    ))
    const ctx = (): any => ({
      state: { user: { id: 3, username: 'ops', role: 'admin' }, profile: { name: 'default' } },
      query: {},
      request: { body: {} },
      params: {},
      status: 200,
      body: null,
    })
    const ttsCtx = ctx()
    const sttCtx = ctx()

    await dispatch(ttsLayer, ttsCtx)
    await dispatch(sttLayer, sttCtx)

    expect(ttsCtx.body).toEqual({ ok: true })
    expect(sttCtx.body).toEqual({ ok: true })
    expect(ttsControllers.saveActiveProvider).toHaveBeenCalledWith(ttsCtx, expect.any(Function))
    expect(localModelControllers.download).toHaveBeenCalledWith(sttCtx, expect.any(Function))
  })

  it('requires a validated Profile for authenticated voice requests', async () => {
    const { ttsProtectedRoutes } = await import('../../packages/server/src/modules/studio/routes/tts')
    const { sttProtectedRoutes } = await import('../../packages/server/src/modules/studio/routes/stt')
    const cases = [
      [ttsProtectedRoutes, 'GET', '/api/studio/tts/settings'],
      [ttsProtectedRoutes, 'POST', '/api/studio/tts/synthesize'],
      [sttProtectedRoutes, 'GET', '/api/studio/stt/settings'],
      [sttProtectedRoutes, 'POST', '/api/studio/stt/local-stream'],
      [sttProtectedRoutes, 'POST', '/api/studio/stt/transcribe'],
    ] as const

    for (const [router, method, path] of cases) {
      const layer = router.stack.find((entry: any) => entry.path === path && entry.methods.includes(method))
      const ctx: any = {
        state: { user: { id: 7, username: 'member', role: 'user' } },
        query: {},
        request: { body: {} },
        params: {},
        status: 200,
        body: null,
      }

      await dispatch(layer, ctx)

      expect(ctx.status, `${method} ${path}`).toBe(400)
      expect(ctx.body).toEqual({ error: 'Profile is required' })
    }
  })

  it('rejects authenticated voice proxy calls for an unassigned path Profile', async () => {
    const { ttsProtectedRoutes } = await import('../../packages/server/src/modules/studio/routes/tts')
    const { sttProtectedRoutes } = await import('../../packages/server/src/modules/studio/routes/stt')
    const cases = [
      [ttsProtectedRoutes, '/api/studio/voice/proxy/:profile/v1/tts'],
      [sttProtectedRoutes, '/api/studio/voice/proxy/:profile/v1/audio/transcriptions'],
    ] as const

    for (const [router, path] of cases) {
      const layer = router.stack.find((entry: any) => entry.path === path)
      const ctx: any = {
        state: {
          user: { id: 7, username: 'member', role: 'user', profiles: ['research'] },
          profile: { name: 'research' },
        },
        query: {},
        request: { body: {} },
        params: { profile: 'private' },
        status: 200,
        body: null,
      }

      await dispatch(layer, ctx)

      expect(ctx.status, path).toBe(403)
      expect(ctx.body).toEqual({ error: 'Profile "private" is not available for this user' })
    }
    expect(ttsControllers.synthesizeVoiceProxy).not.toHaveBeenCalled()
    expect(sttControllers.transcribeVoiceProxy).not.toHaveBeenCalled()
  })

  it('keeps loopback server-token voice proxies available', async () => {
    const { ttsProtectedRoutes } = await import('../../packages/server/src/modules/studio/routes/tts')
    const layer = ttsProtectedRoutes.stack.find((entry: any) => (
      entry.path === '/api/studio/voice/proxy/:profile/v1/tts'
    ))
    const ctx: any = {
      state: { serverTokenAuth: true },
      query: {},
      request: { body: {} },
      params: { profile: 'research' },
      status: 200,
      body: null,
    }

    await dispatch(layer, ctx)

    expect(ctx.state.profile).toEqual({ name: 'research' })
    expect(ttsControllers.synthesizeVoiceProxy).toHaveBeenCalledWith(ctx, expect.any(Function))
  })
})
