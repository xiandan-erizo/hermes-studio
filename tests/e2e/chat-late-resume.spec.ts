import { expect, test, type Page } from '@playwright/test'
import { buildResumeMessages } from '../../packages/server/src/modules/studio/services/chat-run/resume-payload'
import { authenticate, mockHermesApi } from './fixtures'

const slowSessionId = 'late-resume-slow'
const otherSessionId = 'late-resume-other'
const historyMessages = buildResumeMessages([
  { id: 1, session_id: slowSessionId, role: 'user', content: 'Earlier persisted request', timestamp: 1 },
  { id: 2, session_id: slowSessionId, role: 'assistant', content: 'Earlier persisted reply', timestamp: 2, finish_reason: 'stop' },
])

function session(id: string, title: string) {
  return {
    id, title, profile: 'research', source: 'cli', model: 'test-model', provider: 'test-provider',
    preview: '', started_at: 1, ended_at: null, last_active: 2, message_count: 2,
    tool_call_count: 0, workspace: '/workspace/research', category_id: null,
  }
}

const lateResume = {
  session_id: slowSessionId,
  isWorking: true,
  messages: [
    ...historyMessages,
    ...buildResumeMessages([
      { id: 3, session_id: slowSessionId, role: 'user', content: 'Continue persisted request', timestamp: 3 },
    ]),
  ],
  queueLength: 1,
  queueMessages: [{ id: 'queued-follow-up', role: 'user', content: 'Queued follow-up request', timestamp: 4 }],
  events: [{
    event: 'approval.requested',
    data: {
      event: 'approval.requested', session_id: slowSessionId, run_id: 'resumed-run',
      approval_id: 'resumed-approval', command: 'read_file /workspace/research/report.txt',
      description: 'Approve the restored read request', choices: ['once', 'deny'],
      allow_permanent: false, timeout_ms: 300_000, remaining_timeout_ms: 300_000,
    },
  }],
}

async function setup(page: Page) {
  await page.clock.install()
  await authenticate(page, undefined, 'research')
  await page.addInitScript(({ other }) => {
    // The slow session has no automatic response; the test delivers it after fallback.
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = {
      [other]: {
        session_id: other, isWorking: false, events: [],
        messages: [{ id: 1, session_id: other, role: 'assistant', content: 'Other session reply', timestamp: 1 }],
      },
    }
  }, { other: otherSessionId })
  const api = await mockHermesApi(page, { sessions: [
    session(slowSessionId, 'Slow session'), session(otherSessionId, 'Other session'),
  ] })
  const historyRequests: string[] = []
  await page.route(`**/api/studio/sessions/conversations/${slowSessionId}/messages/paginated?**`, route => {
    historyRequests.push(route.request().url())
    return route.fulfill({ json: {
      session: session(slowSessionId, 'Slow session'), messages: historyMessages,
      total: 2, offset: 0, limit: 150, hasMore: false,
    } })
  })
  return { api, historyRequests }
}

async function waitForHistoryFallback(page: Page) {
  await page.goto(`/#/hermes/session/${slowSessionId}`)
  await page.waitForFunction(sid => (window as any).__PW_CHAT_SOCKET__?.emitted
    .some((item: any) => item.event === 'resume' && item.payload.session_id === sid), slowSessionId)
  await page.clock.fastForward(8_001)
  await expect(page.getByText('Earlier persisted reply', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
}

async function deliverLateResume(page: Page) {
  await page.evaluate(payload => {
    const state = (window as any).__PW_CHAT_SOCKET__
    const socket = state.sockets.find((item: any) => item.connected)
    const request = state.emitted.find((item: any) => item.event === 'resume' && item.payload.session_id === payload.session_id)
    socket.__trigger('resumed', { ...payload, request_id: request.payload.request_id })
  }, lateResume)
}

test('restores a running chat, queued request and approval after the eight-second history fallback', async ({ page }) => {
  const { api, historyRequests } = await setup(page)
  await waitForHistoryFallback(page)
  expect(historyRequests).toHaveLength(1)

  await deliverLateResume(page)

  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  await expect(page.getByText('Earlier persisted reply', { exact: true })).toBeVisible()
  await expect(page.getByText('Continue persisted request', { exact: true })).toBeVisible()
  await expect(page.locator('.queue-float-panel')).toContainText('Queued follow-up request')
  await expect(page.getByText('Approve the restored read request', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toBeVisible()

  await page.evaluate(sid => {
    const socket = (window as any).__PW_CHAT_SOCKET__.sockets.find((item: any) => item.connected)
    socket.__trigger('message.delta', { event: 'message.delta', session_id: sid, run_id: 'resumed-run', delta: 'Output after late recovery' })
  }, slowSessionId)
  await expect(page.getByText('Output after late recovery', { exact: true })).toBeVisible()

  await page.evaluate(sid => {
    const socket = (window as any).__PW_CHAT_SOCKET__.sockets.find((item: any) => item.connected)
    socket.__trigger('approval.resolved', {
      event: 'approval.resolved', session_id: sid, run_id: 'resumed-run',
      approval_id: 'resumed-approval', choice: 'deny', resolved: true,
    })
    socket.__trigger('run.completed', {
      event: 'run.completed', session_id: sid, run_id: 'resumed-run',
      output: 'Output after late recovery', queue_remaining: 0,
    })
  }, slowSessionId)
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toHaveCount(0)
  await expect(page.getByText('Earlier persisted reply', { exact: true })).toBeVisible()
  await expect(page.getByText('Output after late recovery', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted
    .filter((item: any) => item.event === 'run'))).toEqual([])
  expect(api.unexpectedRequests).toEqual([])
})

test('ignores the late running snapshot after navigating to another chat session', async ({ page }) => {
  const { api, historyRequests } = await setup(page)
  await waitForHistoryFallback(page)
  expect(historyRequests).toHaveLength(1)

  await page.evaluate(sid => { window.location.hash = `/hermes/session/${sid}` }, otherSessionId)
  await expect(page.getByText('Other session reply', { exact: true })).toBeVisible()
  await deliverLateResume(page)

  await expect(page).toHaveURL(new RegExp(`#/hermes/session/${otherSessionId}$`))
  await expect(page.getByText('Other session reply', { exact: true })).toBeVisible()
  await expect(page.getByText('Continue persisted request', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toHaveCount(0)
  await expect(page.locator('.queue-float-panel')).toHaveCount(0)
  expect(api.unexpectedRequests).toEqual([])
})

test('does not consume the new resume with an old response after returning to the same session', async ({ page }) => {
  await setup(page)
  await waitForHistoryFallback(page)
  await page.evaluate(sid => { window.location.hash = `/hermes/session/${sid}` }, otherSessionId)
  await expect(page.getByText('Other session reply', { exact: true })).toBeVisible()
  await page.evaluate(sid => { window.location.hash = `/hermes/session/${sid}` }, slowSessionId)
  await page.waitForFunction(sid => (window as any).__PW_CHAT_SOCKET__?.emitted
    .filter((item: any) => item.event === 'resume' && item.payload.session_id === sid).length === 2, slowSessionId)
  await deliverLateResume(page)
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toHaveCount(0)

  await page.evaluate(payload => {
    const state = (window as any).__PW_CHAT_SOCKET__
    const requests = state.emitted.filter((item: any) => item.event === 'resume' && item.payload.session_id === payload.session_id)
    const socket = state.sockets.find((item: any) => item.connected)
    socket.__trigger('resumed', { ...payload, request_id: requests[1].payload.request_id })
  }, lateResume)
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toBeVisible()
  await expect(page.getByText('Continue persisted request', { exact: true })).toBeVisible()
})
