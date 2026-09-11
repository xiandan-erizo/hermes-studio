import { expect, test, type Page } from '@playwright/test'
import { createSandboxDocument } from '../../packages/server/src/modules/studio/services/mcp-apps/sandbox'
import { buildSync } from 'esbuild'
import { readFileSync } from 'node:fs'
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
  const app = new App({ name: 'e2e-ticket-card', version: '1.0.0' }, { availableDisplayModes: ['inline', 'fullscreen'] }, { autoResize: false })
  root.dataset.instance = crypto.randomUUID()
  app.addEventListener('hostcontextchanged', context => {
    if (context.displayMode) root.dataset.displayMode = context.displayMode
  })
  app.onteardown = async () => {
    await app.openLink({ url: 'https://teardown.example.test' })
    return {}
  }
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
      const details = document.createElement('button')
      details.textContent = 'Open details'
      details.onclick = () => app.requestDisplayMode({ mode: 'fullscreen' })
      const image = document.createElement('img')
      image.src = 'https://unsafe-mcp-app.example/pixel.png'
      image.style.display = 'none'
      root.append(heading, impact, open, details, image)
      app.sendSizeChanged({ height: 430 })
  })
  app.connect().then(() => { root.dataset.displayMode = app.getHostContext().displayMode })
    .catch(error => { root.textContent = error.message })
  ` },
  bundle: true, format: 'iife', platform: 'browser', write: false,
}).outputFiles[0].text
const appHtml = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<main id="ticket-card-root">loading</main><script>${appScript}</script></body></html>`

const navigationMessage = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'ui/open-link', params: { url: 'https://navigated-mcp-app.example.test/' },
})
const navigationAttemptHtml = '<!doctype html><body><script>setTimeout(() => location.replace("https://navigated-mcp-app.example.test/"), 0)</script></body>'

function toolResult(model: Record<string, unknown> = ticketModel) {
  return JSON.stringify({
    result: '工单已提交 · CYXQ-123',
    structuredContent: model,
  })
}

async function setup(page: Page, withMessages = true, html = appHtml, model: Record<string, unknown> = ticketModel) {
  const liveSandboxOrigin = html !== appHtml ? process.env.MCP_APP_VISUAL_SANDBOX_ORIGIN : undefined
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
      id: 3, session_id: sessionId, role: 'tool', content: toolResult(model),
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
  await page.route('**/api/studio/mcp-apps/sandbox?**', async route => {
    const url = new URL(route.request().url())
    const { html, policy } = createSandboxDocument(url.searchParams.get('parentOrigin') || '', JSON.parse(url.searchParams.get('csp') || '{}'))
    await route.fulfill({ contentType: 'text/html', headers: { 'Content-Security-Policy': policy }, body: html })
  })
  if (liveSandboxOrigin) {
    await page.route(new URL(liveSandboxOrigin).origin + '/api/studio/mcp-apps/sandbox?**', route => route.continue())
  }
  await page.route('**/api/hermes/mcp/apps/resolve', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ok: true,
      ...(liveSandboxOrigin ? { sandboxOrigin: liveSandboxOrigin } : {}),
      app: { id: 'ticket-intake', name: 'Ticket Intake' },
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
        text: html,
        _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } },
      },
    }),
  }))
}

test('ordinary users render and replay a standard MCP App while tool traces stay hidden', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 960 })
  await setup(page)
  await page.goto(`/#/hermes/session/${sessionId}`)

  const card = page.locator('.mcp-app-result')
  const frame = card.frameLocator('iframe').frameLocator('iframe')
  await expect(card.locator('.mcp-app-title')).toHaveText('Ticket Intake')
  await expect(card.locator('.mcp-app-frame-shell')).toBeVisible()
  await expect(frame.getByRole('heading', { name: '审批页面偶发 500' })).toBeVisible()
  await expect(frame.getByText('华南销售团队 3 人', { exact: true })).toBeVisible()
  await expect(frame.locator('#ticket-card-root')).toHaveAttribute('data-action', 'submit')
  await expect(card.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin')
  expect(new URL(await card.locator('iframe').getAttribute('src') || '').origin).not.toBe(new URL(page.url()).origin)
  await expect(card.locator('iframe')).toHaveAttribute('style', /430px/)
  await expect(page.locator('.tool-run-card')).toHaveCount(0)
  const expand = card.getByRole('button', { name: 'Expand', exact: true })
  await expect(expand).toHaveText('')
  const instance = await frame.locator('#ticket-card-root').getAttribute('data-instance')
  await expand.click()
  await expect(card.locator('.expand-control')).toHaveAttribute('aria-expanded', 'true')
  await expect(card.locator('.expand-control')).toHaveAttribute('aria-label', 'Collapse')
  await expect(frame.locator('#ticket-card-root')).toHaveAttribute('data-display-mode', 'fullscreen')
  await card.locator('.expand-control').click()
  await expect(frame.locator('#ticket-card-root')).toHaveAttribute('data-display-mode', 'inline')
  await expect(frame.locator('#ticket-card-root')).toHaveAttribute('data-instance', instance!)
  await frame.getByRole('button', { name: 'Open details' }).click()
  await expect(frame.locator('#ticket-card-root')).toHaveAttribute('data-display-mode', 'fullscreen')
  await card.locator('.expand-control').focus()
  await page.keyboard.press('Escape')
  await expect(frame.locator('#ticket-card-root')).toHaveAttribute('data-display-mode', 'inline')
  await expect(card.locator('.expand-control')).toBeFocused()
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
  const frame = card.frameLocator('iframe').frameLocator('iframe')
  await frame.getByRole('button', { name: '查看 CYXQ-123' }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__OPENED_MCP_APP_URLS__)).toEqual([
    'https://jira.example.test/browse/CYXQ-123',
  ])
  expect(await page.evaluate(() => (window as any).__MCP_APP_ESCAPED__)).toBeUndefined()
  expect(outgoing).toEqual([])
})

test('blocks an App from navigating its sandboxed document', async ({ page }) => {
  const navigationRequests: string[] = []
  await page.route('https://navigated-mcp-app.example.test/', route => {
    navigationRequests.push(route.request().url())
    return route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><body>navigated<script>setTimeout(() => parent.postMessage(${navigationMessage}, '*'), 0)</script></body>`,
    })
  })
  await setup(page, true, navigationAttemptHtml)
  await page.goto(`/#/hermes/session/${sessionId}`)

  await page.waitForTimeout(1_000)

  expect(navigationRequests).toEqual([])
  await expect.poll(() => page.evaluate(() => (window as any).__OPENED_MCP_APP_URLS__)).toEqual([])
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
  await expect(page.locator('.mcp-app-result').frameLocator('iframe').frameLocator('iframe').getByRole('heading', { name: '审批页面偶发 500' })).toBeVisible()
  await expect(page.locator('.tool-run-card')).toHaveCount(0)
})

test('reconnects the App after its existing chat row moves in the document', async ({ page }) => {
  await setup(page)
  await page.goto(`/#/hermes/session/${sessionId}`)
  const card = page.locator('.mcp-app-result')
  const heading = card.frameLocator('iframe').frameLocator('iframe').getByRole('heading', { name: '审批页面偶发 500' })
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
  await expect(card.frameLocator('iframe').frameLocator('iframe').getByRole('heading', { name: '审批页面偶发 500' })).toBeVisible()
  expect(requests).toBe(2)
})

test('previews a supplied bundled ticket widget in Studio', async ({ page }, testInfo) => {
  const widgetPath = process.env.MCP_APP_VISUAL_WIDGET_PATH
  test.skip(!widgetPath, 'Set MCP_APP_VISUAL_WIDGET_PATH to inspect a bundled plugin without adding a cross-repository fixture.')
  await page.setViewportSize({ width: 1280, height: 960 })
  await setup(page, true, readFileSync(widgetPath!, 'utf8'), {
    ...ticketModel, kind: 'draft', heading: '工单草稿', status: '草稿 · 尚未提交',
    ticketId: null, ticketUrl: null,
    description: '审批页面点击提交后偶发 500，刷新页面后可恢复。\n期望提交后正常进入下一步，不需要手动刷新。\n发生于测试环境，当前影响 3 位测试用户。',
    facts: [
      { label: '客户', value: 'MCP Apps 测试客户' },
      { label: '影响范围', value: '测试用户 3 人' },
      { label: '环境', value: '测试环境' },
      { label: '实际表现', value: '提交后提示 500，刷新后恢复' },
      { label: '期望表现', value: '审批正常提交' },
    ],
    missing: ['报告人', '处理人'],
    footer: '这是当前草稿。请继续补充或修正信息，确认创建后才会提交。',
  })
  await page.goto('/#/hermes/session/' + sessionId)
  const card = page.locator('.mcp-app-result')
  const view = card.frameLocator('iframe').frameLocator('iframe')
  await expect(view.getByRole('heading', { name: '审批页面偶发 500' })).toBeVisible()
  await expect(view.locator('#ticket-details')).toBeHidden()
  await view.locator('html').evaluate(node => { node.dataset.testInstance = 'original' })
  await card.screenshot({ path: testInfo.outputPath('ticket-desktop.png') })
  await view.getByRole('button', { name: '查看详情' }).click()
  await expect(view.locator('html')).toHaveAttribute('data-display-mode', 'fullscreen')
  await expect(view.locator('#ticket-details')).toBeVisible()
  await card.screenshot({ path: testInfo.outputPath('ticket-fullscreen.png') })
  await view.locator('body').click()
  await page.keyboard.press('Escape')
  await expect(view.locator('html')).toHaveAttribute('data-display-mode', 'inline')
  await expect(view.locator('html')).toHaveAttribute('data-test-instance', 'original')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(view.getByRole('button', { name: '查看详情' })).toBeVisible()
  await expect.poll(() => view.locator('body').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
  await card.screenshot({ path: testInfo.outputPath('ticket-mobile.png') })
  await page.evaluate(() => localStorage.setItem('hermes_brightness', 'dark'))
  await page.reload()
  await expect(view.locator('html')).toHaveAttribute('data-theme', 'dark')
  await card.screenshot({ path: testInfo.outputPath('ticket-dark.png') })
})
