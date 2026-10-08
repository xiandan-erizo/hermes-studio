// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ResumeSessionPayload } from '@/api/studio/chat'
import type { fetchSessionMessagesPage } from '@/api/studio/sessions'

const api = vi.hoisted(() => ({
  callbacks: [] as Array<{ id: string; callback: (data: ResumeSessionPayload) => void }>,
  registerSessionHandlers: vi.fn(),
  fetchPage: vi.fn<typeof fetchSessionMessagesPage>(),
}))
vi.mock('@/api/studio/chat', () => ({
  resumeSession: vi.fn((id: string, callback: (data: ResumeSessionPayload) => void) => { api.callbacks.push({ id, callback }) }),
  registerSessionHandlers: api.registerSessionHandlers,
  unregisterSessionHandlers: vi.fn(),
  startRunViaSocket: vi.fn(),
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  respondToolApproval: vi.fn(), respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn(), onSessionCommand: vi.fn(),
  onSessionTitleUpdated: vi.fn(), onSessionWorkspaceUpdated: vi.fn(), onSessionSettingsUpdated: vi.fn(),
}))
vi.mock('@/api/client', () => ({ getActiveProfileName: () => 'default', hasApiKey: () => false }))
vi.mock('@/api/studio/sessions', () => ({
  archiveSession: vi.fn(), deleteSession: vi.fn(), fetchHermesSession: vi.fn(), fetchSessions: vi.fn(async () => []),
  fetchSessionMessagesPage: api.fetchPage,
  fetchWorkspaceRunChangeFile: vi.fn(), setSessionModel: vi.fn(), setSessionPushEnabled: vi.fn(), setSessionReasoningEffort: vi.fn(),
}))
vi.mock('@/api/studio/download', () => ({ getDownloadUrl: () => '' }))
vi.mock('@/utils/completion-sound', () => ({ primeCompletionSound: vi.fn(), playCompletionSound: vi.fn() }))
import { useChatStore, type Session } from '@/stores/hermes/chat'

function session(id: string): Session {
  return { id, title: id, profile: 'default', messages: [], createdAt: 1, updatedAt: 1 }
}

function resumed(id = 'slow'): ResumeSessionPayload {
  return {
    session_id: id, isWorking: true, queueLength: 1,
    messages: [{ id: 'socket-new', session_id: id, role: 'user', content: 'latest request', timestamp: 2 }],
    events: [],
  }
}

function history(id = 'slow'): Awaited<ReturnType<typeof fetchSessionMessagesPage>> {
  return {
    session: { id, title: 'old HTTP snapshot', profile: 'default' },
    messages: [{ id: 'http-old', role: 'user', content: 'old history', timestamp: 1 }],
    total: 1, hasMore: false,
  } as Awaited<ReturnType<typeof fetchSessionMessagesPage>>
}

describe('chat session recovery after resume timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    api.callbacks.length = 0
    api.fetchPage.mockResolvedValue(history())
    setActivePinia(createPinia())
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.each([7000, 8001, 20000])('restores live output and pending interactions after %i ms', async delay => {
    const store = useChatStore()
    store.sessions = [session('slow')]
    const switching = store.switchSession('slow')
    await vi.advanceTimersByTimeAsync(delay)
    api.callbacks[0].callback({ ...resumed(),
      queueMessages: [{ id: 'queued-1', content: 'next request', timestamp: 2 }],
      events: [
        { event: 'approval.requested', data: { event: 'approval.requested', approval_id: 'approval-1', command: 'check', choices: ['once', 'deny'] } },
        { event: 'clarify.requested', data: { event: 'clarify.requested', clarify_id: 'question-1', question: 'Which environment?' } },
      ],
    })
    await switching

    expect(store.isStreaming).toBe(true)
    expect(store.queueLengths.get('slow')).toBe(1)
    expect(store.queuedUserMessages.get('slow')).toMatchObject([{ id: 'queued-1', content: 'next request' }])
    expect(store.activePendingApproval?.approvalId).toBe('approval-1')
    expect(store.activePendingClarify?.clarifyId).toBe('question-1')
    expect(api.fetchPage).toHaveBeenCalledTimes(delay > 8000 ? 1 : 0)
    expect(api.registerSessionHandlers).toHaveBeenCalledOnce()
    const handlers = api.registerSessionHandlers.mock.calls[0][1]
    handlers.onMessageDelta({ event: 'message.delta', session_id: 'slow', delta: 'continued output' })
    expect(store.messages.some(message => message.content === 'continued output')).toBe(true)
  })

  it('keeps a late socket snapshot when the HTTP fallback finishes afterwards', async () => {
    let resolveHistory!: (value: Awaited<ReturnType<typeof fetchSessionMessagesPage>>) => void
    api.fetchPage.mockImplementationOnce(() => new Promise(resolve => { resolveHistory = resolve }))
    const store = useChatStore()
    store.sessions = [session('slow')]
    const switching = store.switchSession('slow')
    await vi.advanceTimersByTimeAsync(8001)
    api.callbacks[0].callback(resumed())
    resolveHistory(history())
    await switching

    expect(store.activeSession?.title).toBe('slow')
    expect(store.messages.map(message => message.id)).toEqual(['socket-new'])
    expect(store.isStreaming).toBe(true)
    expect(api.registerSessionHandlers).toHaveBeenCalledOnce()
  })

  it('ignores an old HTTP fallback and late resume after the user switches away', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    let resolveHistory!: (value: Awaited<ReturnType<typeof fetchSessionMessagesPage>>) => void
    api.fetchPage.mockImplementationOnce(() => new Promise(resolve => { resolveHistory = resolve }))
    const store = useChatStore()
    store.sessions = [session('slow'), session('other')]
    const oldSwitch = store.switchSession('slow')
    await vi.advanceTimersByTimeAsync(8001)
    const newSwitch = store.switchSession('other')
    api.callbacks[1].callback({ ...resumed('other'), isWorking: false, queueLength: 0 })
    await newSwitch
    api.callbacks[0].callback(resumed())
    resolveHistory(history())
    await oldSwitch

    expect(store.activeSessionId).toBe('other')
    expect(store.activeSession?.title).toBe('other')
    expect(store.sessions.find(item => item.id === 'slow')?.messages).toEqual([])
    expect(store.isStreaming).toBe(false)
    expect(api.registerSessionHandlers).not.toHaveBeenCalled()
    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })
})
