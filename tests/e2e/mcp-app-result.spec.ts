import { expect, test, type Page } from '@playwright/test'
import { buildSync } from 'esbuild'
import { authenticate, mockHermesApi } from './fixtures'
import { buildOutboundRunEvent, buildResumeMessages } from '../../packages/server/src/modules/studio/services/chat-run/resume-payload'

// Exercise Chrome's isolated iframe renderer, including srcdoc navigation.
// The headless shell can hide initialization races seen in desktop Chrome.
test.use({ channel: 'chromium', launchOptions: { args: ['--site-per-process'] } })

const sessionId = 'mcp-app-demo'
const userToken = [
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  Buffer.from(JSON.stringify({
    sub: '7', username: 'member', role: 'user', type: 'access',
    aud: 'hermes-web-ui', iat: 1_760_000_000, exp: 4_102_444_800,
  })).toString('base64url'),
  'test-signature',
].join('.')

const ticketModel = {
  schemaVersion: 1,
  kind: 'receipt',
  heading: '工单已提交 · CYXQ-123',
  title: '审批页面偶发 500',
  status: '已提交 · CYXQ-123',
  issueType: '工单缺陷',
  priority: 'P2',
  description: '提交审批后出现 500，刷新后可以继续。'.repeat(80),
  facts: [
    { label: '客户', value: '示例公司' },
    { label: '影响范围', value: '华南销售团队 3 人' },
  ],
  missing: [],
  ticketId: 'CYXQ-123',
  ticketUrl: 'https://jira.example.test/browse/CYXQ-123',
  footer: '已根据确认内容创建工单，可通过工单链接查看进展。',
}

const appScript = buildSync({
  stdin: { resolveDir: process.cwd(), contents: String.raw`
  import { App } from '@modelcontextprotocol/ext-apps/app-with-deps'
  const root = document.querySelector('#ticket-card-root')
  const app = new App({ name: 'e2e-ticket-card', version: '1.0.0' }, {}, { autoResize: false })
  try { parent.__MCP_APP_ESCAPED__ = true } catch {}
  app.addEventListener('toolinput', input => { root.dataset.action = input.arguments?.action || '' })
  app.addEventListener('toolresult', result => {
      const model = result.structuredContent
      root.replaceChildren()
      const heading = document.createElement('h1')
      heading.textContent = model.title
      const impact = document.createElement('p')
      impact.textContent = model.facts.find(fact => fact.label === '影响范围').value
      const open = document.createElement('button')
      open.textContent = '查看 ' + model.ticketId
      open.onclick = () => app.openLink({ url: model.ticketUrl })
      const image = document.createElement('img')
      image.src = 'https://unsafe-mcp-app.example/pixel.png'
      image.style.display = 'none'
      root.append(heading, impact, open, image)
      app.sendSizeChanged({ height: 430 })
  })
  app.connect().catch(error => { root.textContent = error.message })
  ` },
  bundle: true, format: 'iife', platform: 'browser', write: false,
}).outputFiles[0].text
const appHtml = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<main id="ticket-card-root">loading</main><script>${appScript}</script></body></html>`

function toolResult() {
  return JSON.stringify({
    result: '工单已提交 · CYXQ-123',
    structuredContent: ticketModel,
  })
}

async function setup(page: Page, withMessages = true) {
  await authenticate(page, userToken, 'research')
  const messages = buildResumeMessages(withMessages ? [
    { id: 1, session_id: sessionId, role: 'user', content: '展示工单结果', timestamp: 1 },
    {
      id: 2, session_id: sessionId, role: 'assistant', content: '', timestamp: 2,
      tool_calls: [{
        id: 'app-call', type: 'function',
        function: {
          name: 'mcp__ticket__render_ticket_card',
          arguments: JSON.stringify({ action: 'submit', result: { ticket_id: 'CYXQ-123' } }),
        },
      }],
    },
    {
      id: 3, session_id: sessionId, role: 'tool', content: toolResult(),
      tool_call_id: 'app-call', tool_name: 'mcp__ticket__render_ticket_card', timestamp: 3,
    },
    { id: 4, session_id: sessionId, role: 'assistant', content: '请查看工单回执。', timestamp: 4, finish_reason: 'stop' },
  ] : [{ id: 1, session_id: sessionId, role: 'assistant', content: 'Ready.', timestamp: 1 }])
  await page.addInitScript(({ sid, restore, messages }) => {
    localStorage.setItem('hermes_show_tool_calls', 'false')
    ;(window as any).__OPENED_MCP_APP_URLS__ = []
    window.open = ((url?: string | URL) => {
      ;(window as any).__OPENED_MCP_APP_URLS__.push(String(url || ''))
      return null
    }) as typeof window.open
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = { [sid]: {
      session_id: sid,
      isWorking: !restore,
      events: [],
      messages,
    } }
  }, { sid: sessionId, restore: withMessages, messages })
  await mockHermesApi(page, { sessions: [{
    id: sessionId,
    profile: 'research',
    source: 'cli',
    model: 'test-model',
    provider: 'test-provider',
    title: 'MCP App result',
    preview: '',
    started_at: 1,
    ended_at: null,
    last_active: 4,
    message_count: withMessages ? 4 : 0,
    tool_call_count: withMessages ? 1 : 0,
    workspace: '/workspace/research',
    category_id: null,
  }] })
  await page.route('**/api/hermes/mcp/apps/resolve', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ok: true,
      tool: {
        name: 'mcp__ticket__render_ticket_card',
        raw_name: 'render_ticket_card',
        server: 'ticket',
        description: 'Render ticket card',
        input_schema: { type: 'object' },
        output_schema: { type: 'object' },
        annotations: { readOnlyHint: true },
        _meta: { ui: { resourceUri: 'ui://ticket-intake/ticket-card-v1.html' } },
      },
      resource: {
        uri: 'ui://ticket-intake/ticket-card-v1.html',
        mimeType: 'text/html;profile=mcp-app',
        text: appHtml,
        _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } },
      },
    }),
  }))
}

test('ordinary users render and replay a standard MCP App while tool traces stay hidden', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 960 })
  await setup(page)
  await page.goto(`/#/hermes/session/${sessionId}`)

  const card = page.locator('.mcp-app-result')
  const frame = card.frameLocator('iframe')
  await expect(frame.getByRole('heading', { name: '审批页面偶发 500' })).toBeVisible()
  await expect(frame.getByText('华南销售团队 3 人', { exact: true })).toBeVisible()
  await expect(frame.locator('#ticket-card-root')).toHaveAttribute('data-action', 'submit')
  await expect(card.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts')
  await expect(card.locator('iframe')).toHaveAttribute('style', /430px/)
  await expect(page.locator('.tool-run-card')).toHaveCount(0)
  const expand = card.getByRole('button', { name: 'Expand', exact: true })
  await expect(expand).toHaveText('')
  await expand.click()
  await expect(card.locator('.expand-control')).toHaveAttribute('aria-expanded', 'true')
  await expect(card.locator('.expand-control')).toHaveAttribute('aria-label', 'Collapse')
  await card.screenshot({ path: testInfo.outputPath('mcp-app-desktop.png') })

  await page.reload()
  await expect(frame.getByRole('heading', { name: '审批页面偶发 500' })).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(frame.getByText('华南销售团队 3 人', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('mcp-app-mobile.png'), fullPage: true })
})

test('MCP App navigation is host-mediated and undeclared network access stays blocked', async ({ page }) => {
  const outgoing: string[] = []
  await page.route('https://unsafe-mcp-app.example/**', route => {
    outgoing.push(route.request().url())
    return route.abort()
  })
  await setup(page)
  await page.goto(`/#/hermes/session/${sessionId}`)

  const card = page.locator('.mcp-app-result')
  const frame = card.frameLocator('iframe')
  await frame.getByRole('button', { name: '查看 CYXQ-123' }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__OPENED_MCP_APP_URLS__)).toEqual([
    'https://jira.example.test/browse/CYXQ-123',
  ])
  expect(await page.evaluate(() => (window as any).__MCP_APP_ESCAPED__)).toBeUndefined()
  expect(outgoing).toEqual([])
})

test('a completed live MCP tool call creates an App row', async ({ page }) => {
  await setup(page, false)
  await page.goto(`/#/hermes/session/${sessionId}`)
  await page.waitForFunction(() => Boolean((window as any).__PW_CHAT_SOCKET__?.latest))
  const completed = buildOutboundRunEvent('tool.completed', {
    event: 'tool.completed', session_id: sessionId, run_id: 'app-run', tool_call_id: 'app-call',
    tool: 'mcp__ticket__render_ticket_card', output: toolResult(),
  })
  await page.evaluate(({ sid, completed }) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'app-run' })
    socket.__trigger('tool.started', {
      event: 'tool.started', session_id: sid, run_id: 'app-run', tool_call_id: 'app-call',
      tool: 'mcp__ticket__render_ticket_card', arguments: { action: 'submit' },
    })
    socket.__trigger('tool.completed', completed)
  }, { sid: sessionId, completed })
  await expect(page.locator('.mcp-app-result').frameLocator('iframe').getByRole('heading', { name: '审批页面偶发 500' })).toBeVisible()
  await expect(page.locator('.tool-run-card')).toHaveCount(0)
})

test('reconnects the App after its existing chat row moves in the document', async ({ page }) => {
  await setup(page)
  await page.goto(`/#/hermes/session/${sessionId}`)
  const card = page.locator('.mcp-app-result')
  const heading = card.frameLocator('iframe').getByRole('heading', { name: '审批页面偶发 500' })
  await expect(heading).toBeVisible()
  await card.evaluate(element => {
    const row = element.closest('.virtual-row')!
    const parent = row.parentElement!
    const next = row.nextSibling
    parent.removeChild(row)
    parent.insertBefore(row, next)
  })
  await expect(heading).toBeVisible()
})

test('offers a retry and text fallback when the App never initializes', async ({ page }) => {
  await setup(page)
  let requests = 0
  await page.route('**/api/hermes/mcp/apps/resolve', async route => {
    requests += 1
    if (requests > 1) return route.fallback()
    return route.fulfill({
      json: {
        ok: true,
        tool: { name: 'mcp__ticket__render_ticket_card', raw_name: 'render_ticket_card', input_schema: {}, _meta: {} },
        resource: { uri: 'ui://test/broken.html', mimeType: 'text/html;profile=mcp-app', text: '<html><body></body></html>', _meta: {} },
      },
    })
  })
  await page.goto(`/#/hermes/session/${sessionId}`)
  const card = page.locator('.mcp-app-result')
  await expect(card.getByRole('alert')).toBeVisible({ timeout: 18000 })
  await expect(card).toContainText('工单已提交 · CYXQ-123')
  await card.getByRole('button', { name: 'Retry' }).click()
  await expect(card.frameLocator('iframe').getByRole('heading', { name: '审批页面偶发 500' })).toBeVisible()
  expect(requests).toBe(2)
})
