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
  const app = new App({ name: 'e2e-ticket-card', version: '1.0.0' }, { availableDisplayModes: ['inline', 'fullscreen', 'pip'] }, { autoResize: false })
  root.dataset.instance = crypto.randomUUID()
  console.log('mcp-app-instance:' + root.dataset.instance)
  app.addEventListener('hostcontextchanged', context => {
    if (context.displayMode) root.dataset.displayMode = context.displayMode
    if (context.platform) root.dataset.platform = context.platform
  })
  app.onteardown = async () => {
    await app.openLink({ url: 'https://teardown.example.test' })
    return {}
  }
  try { parent.__MCP_APP_ESCAPED__ = true } catch {}
  app.addEventListener('toolinput', input => { root.dataset.action = input.arguments?.action || '' })
  function render(model) {
      root.replaceChildren()
      const heading = document.createElement('h1')
      heading.textContent = model.title
      const impact = document.createElement('p')
      impact.textContent = model.facts?.find(fact => fact.label === '影响范围')?.value || ''
      const open = document.createElement('button')
      open.textContent = '查看 ' + model.ticketId
      open.onclick = () => app.openLink({ url: model.ticketUrl })
      const details = document.createElement('button')
      details.textContent = 'Open details'
      details.onclick = () => app.requestDisplayMode({ mode: 'fullscreen' })
      const pip = document.createElement('button')
      pip.textContent = 'Keep visible'
      pip.onclick = () => app.requestDisplayMode({ mode: 'pip' })
      const refresh = document.createElement('button')
      refresh.textContent = 'Refresh'
      refresh.onclick = async () => {
        const result = await app.callServerTool({ name: 'get_ticket_draft', arguments: {} })
        if (!result.isError && result.structuredContent) render(result.structuredContent)
      }
      const image = document.createElement('img')
      image.src = 'https://unsafe-mcp-app.example/pixel.png'
      image.style.display = 'none'
      root.append(heading, impact, open, details, pip, refresh, image)
      app.sendSizeChanged({ height: 430 })
  }
  app.addEventListener('toolresult', result => render(result.structuredContent))
  app.connect().then(() => {
    root.dataset.displayMode = app.getHostContext().displayMode
    root.dataset.platform = app.getHostContext().platform || ''
  })
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

function toolResult(model: Record<string, unknown> = ticketModel, meta?: Record<string, unknown>) {
  return JSON.stringify({
    result: '工单已提交 · CYXQ-123',
    structuredContent: model,
    ...(meta ? { _meta: meta } : {}),
  })
}

async function setup(page: Page, withMessages = true, html = appHtml, model: Record<string, unknown> = ticketModel, withPlainTool = false, meta?: Record<string, unknown>, history?: Parameters<typeof buildResumeMessages>[0]) {
  const liveSandboxOrigin = html !== appHtml ? process.env.MCP_APP_VISUAL_SANDBOX_ORIGIN : undefined
  await authenticate(page, userToken, 'research')
  const messages = buildResumeMessages(history ?? (withMessages ? [
    { id: 1, session_id: sessionId, role: 'user', content: '展示工单结果', timestamp: 1 },
    ...(withPlainTool ? [
      { id: 10, session_id: sessionId, role: 'assistant', content: '', timestamp: 1,
        tool_calls: [{ id: 'identity-call', type: 'function', function: {
          name: 'mcp__hermes_studio_use__hermes_studio_use_toolset', arguments: '{}',
        } }] },
      { id: 11, session_id: sessionId, role: 'tool', timestamp: 1,
        tool_call_id: 'identity-call', tool_name: 'mcp__hermes_studio_use__hermes_studio_use_toolset',
        content: JSON.stringify({ result: JSON.stringify({ identity: { role: 'user' } }) }) },
    ] : []),
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
      id: 3, session_id: sessionId, role: 'tool', content: toolResult(model, meta),
      tool_call_id: 'app-call', tool_name: 'mcp__ticket__render_ticket_card', timestamp: 3,
    },
    { id: 4, session_id: sessionId, role: 'assistant', content: '请查看工单回执。', timestamp: 4, finish_reason: 'stop' },
  ] : [{ id: 1, session_id: sessionId, role: 'assistant', content: 'Ready.', timestamp: 1 }]))
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
  const appInstances: string[] = []
  page.on('console', message => {
    if (message.text().startsWith('mcp-app-instance:')) appInstances.push(message.text())
  })
  await page.setViewportSize({ width: 1280, height: 960 })
  await setup(page)
  await page.goto(`/#/hermes/session/${sessionId}`)

  const card = page.locator('.mcp-app-result')
  const frame = card.frameLocator('iframe').frameLocator('iframe')
  await expect(card.locator('.mcp-app-title')).toHaveText('Ticket Intake')
  await expect(card.locator('.mcp-app-frame-shell')).toBeVisible()
  await expect(frame.getByRole('heading', { name: '审批页面偶发 500' })).toBeVisible()
  const initialInstance = await frame.locator('#ticket-card-root').getAttribute('data-instance')
  await expect(frame.getByText('华南销售团队 3 人', { exact: true })).toBeVisible()
  await expect(frame.locator('#ticket-card-root')).toHaveAttribute('data-action', 'submit')
  await expect(card.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin')
  expect(new URL(await card.locator('iframe').getAttribute('src') || '').origin).not.toBe(new URL(page.url()).origin)
  await expect(frame.locator('#ticket-card-root')).toHaveAttribute('data-display-mode', 'pip')
  await expect(card).toHaveClass(/is-pip/)
  await expect(frame.locator('#ticket-card-root')).toHaveAttribute('data-instance', initialInstance!)
  expect(appInstances).toHaveLength(1)
  await page.locator('.input-textarea').fill('补充影响范围')
  await page.locator('.input-textarea').press('Enter')
  await expect(frame.locator('#ticket-card-root')).toHaveAttribute('data-instance', initialInstance!)
  await expect(page.locator('.tool-run-card')).toHaveCount(0)
  await frame.getByRole('button', { name: 'Keep visible' }).click()
  await expect(frame.locator('#ticket-card-root')).toHaveAttribute('data-display-mode', 'pip')
  await expect(card).toHaveClass(/is-pip/)
  const expand = card.locator('button[aria-expanded]')
  const pipInstance = await frame.locator('#ticket-card-root').getAttribute('data-instance')
  await expand.click()
  await expect(frame.locator('#ticket-card-root')).toHaveAttribute('data-display-mode', 'fullscreen')
  await page.keyboard.press('Escape')
  await expect(frame.locator('#ticket-card-root')).toHaveAttribute('data-display-mode', 'pip')
  await expect(frame.locator('#ticket-card-root')).toHaveAttribute('data-instance', pipInstance!)
  await card.getByRole('button', { name: 'Unpin', exact: true }).click()
  await expect(frame.locator('#ticket-card-root')).toHaveAttribute('data-display-mode', 'inline')
  await expect(card.locator('iframe')).toHaveAttribute('style', /430px/)
  await expect(expand).toHaveText('')
  const instance = await frame.locator('#ticket-card-root').getAttribute('data-instance')
  await expand.click()
  await expect(expand).toHaveAttribute('aria-expanded', 'true')
  await expect(expand).toHaveAttribute('aria-label', 'Collapse')
  await expect(frame.locator('#ticket-card-root')).toHaveAttribute('data-display-mode', 'fullscreen')
  await expand.click()
  await expect(frame.locator('#ticket-card-root')).toHaveAttribute('data-display-mode', 'inline')
  await expect(frame.locator('#ticket-card-root')).toHaveAttribute('data-instance', instance!)
  await frame.getByRole('button', { name: 'Open details' }).click()
  await expect(frame.locator('#ticket-card-root')).toHaveAttribute('data-display-mode', 'fullscreen')
  await expand.focus()
  await page.keyboard.press('Escape')
  await expect(frame.locator('#ticket-card-root')).toHaveAttribute('data-display-mode', 'inline')
  await expect(expand).toBeFocused()
  await card.screenshot({ path: testInfo.outputPath('mcp-app-desktop.png') })

  await page.reload()
  await expect(frame.getByRole('heading', { name: '审批页面偶发 500' })).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(frame.getByText('华南销售团队 3 人', { exact: true })).toBeVisible()
  await expect(frame.locator('#ticket-card-root')).toHaveAttribute('data-platform', 'mobile')
  await expect.poll(async () => {
    const mobileCardBottom = await card.evaluate(element => element.getBoundingClientRect().bottom)
    const composerTop = await page.locator('.input-textarea').evaluate(element => element.getBoundingClientRect().top)
    return mobileCardBottom < composerTop
  }).toBe(true)
  await page.locator('.input-textarea').click()
  await expect(page.locator('.input-textarea')).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('mcp-app-mobile.png'), fullPage: true })
})

test('updates the current App in place through standard tools/call', async ({ page }) => {
  let calls = 0
  await setup(page)
  await page.route('**/api/hermes/mcp/apps/call-tool', async route => {
    const body = route.request().postDataJSON()
    calls += 1
    expect(body.params.name).toBe('get_ticket_draft')
    return route.fulfill({ json: {
      content: [{ type: 'text', text: '最新草稿' }],
      structuredContent: { ...ticketModel, title: '最新草稿标题', heading: '工单草稿' },
    } })
  })
  await page.goto(`/#/hermes/session/${sessionId}`)

  const card = page.locator('.mcp-app-result')
  const view = card.frameLocator('iframe').frameLocator('iframe')
  await expect(view.getByRole('heading', { name: '审批页面偶发 500' })).toBeVisible()
  const instance = await view.locator('#ticket-card-root').getAttribute('data-instance')
  await view.getByRole('button', { name: 'Refresh' }).click()
  await expect.poll(() => calls).toBe(1)
  await expect(view.getByRole('heading', { name: '最新草稿标题' })).toBeVisible()
  await expect(card).toHaveCount(1)
  await expect(view.locator('#ticket-card-root')).toHaveAttribute('data-instance', instance!)
  expect(calls).toBe(1)
})

test('shows the latest version in one PiP when the same draft was rendered twice', async ({ page }, testInfo) => {
  const widgetPath = process.env.MCP_APP_VISUAL_WIDGET_PATH
  test.skip(!widgetPath, 'Set MCP_APP_VISUAL_WIDGET_PATH to test the independently packaged plugin.')
  const debugEvents: Array<{ event: string; toolName?: string; version?: number; code?: string; outcome?: string }> = []
  page.on('console', message => {
    if (!message.text().startsWith('[MCP App Debug] ')) return
    debugEvents.push(JSON.parse(message.text().slice('[MCP App Debug] '.length)))
  })
  await page.addInitScript(() => localStorage.setItem('hermes_mcp_app_debug', '1'))
  await page.setViewportSize({ width: 1280, height: 960 })
  const draft = (version: number, impact: string) => ({ draft_id: 'dr_test', status: 'draft', version, extracted_fields: { impact_scope: impact } })
  const model = (impact: string) => ({ ...ticketModel, kind: 'draft', heading: '工单草稿', status: '草稿 · 尚未提交', ticketId: null, ticketUrl: null,
    facts: [{ label: '影响范围', value: impact }], missing: ['报告人'], footer: '当前草稿尚未提交 Jira。' })
  const meta = (version: number, impact: string) => ({ ticketEdit: { draftId: 'dr_test', version, editToken: `test-token-${version}`,
    fields: { title: '审批页面偶发 500', description: '审批提交失败', actual_behavior: '', expected_behavior: '', impact_scope: impact, environment: '', product_module: '', attachment_notes: '' } } })
  const rendered = (version: number, impact: string) => ({ result: '工单草稿', structuredContent: model(impact), _meta: meta(version, impact) })
  const history: Parameters<typeof buildResumeMessages>[0] = [
    { id: 1, session_id: sessionId, role: 'user', content: '新建草稿', timestamp: 1 },
    { id: 2, session_id: sessionId, role: 'assistant', content: '', timestamp: 2,
      tool_calls: [{ id: 'render-v2', type: 'function', function: { name: 'mcp__ticket__render_ticket_card', arguments: JSON.stringify({ action: 'prepare', result: { draft: draft(2, '3人') } }) } }] },
    { id: 3, session_id: sessionId, role: 'tool', tool_name: 'mcp__ticket__render_ticket_card', tool_call_id: 'render-v2', content: JSON.stringify(rendered(2, '3人')), timestamp: 3 },
  ]
  await setup(page, true, readFileSync(widgetPath!, 'utf8'), model('3人'), false, meta(2, '3人'), history)
  let latestVersion = 2
  const contexts: any[] = []
  const appMessages: any[] = []
  await page.route('**/api/hermes/mcp/apps/call-tool', async route => {
    const request = route.request().postDataJSON()
    expect(request.params.name).toBe('get_ticket_draft')
    if (request.params.arguments.editToken === 'test-token-2') {
      return route.fulfill({ json: { isError: true, content: [{ type: 'text', text: '编辑授权已过期' }],
        _meta: { ticketEditError: { code: 'edit_authorization_expired' } } } })
    }
    await route.fulfill({ json: { content: [{ type: 'text', text: '当前草稿' }], structuredContent: model(latestVersion === 2 ? '3人' : '10人'), _meta: meta(latestVersion, latestVersion === 2 ? '3人' : '10人') } })
  })
  await page.route('**/api/hermes/mcp/apps/model-context', route => {
    contexts.push(route.request().postDataJSON())
    return route.fulfill({ json: {} })
  })
  await page.route('**/api/hermes/mcp/apps/message', route => {
    const body = route.request().postDataJSON()
    appMessages.push(body)
    return route.fulfill({ json: { message: body.params.content[0].text } })
  })
  let hostRefreshCalls = 0
  await page.route('**/api/hermes/mcp/apps/refresh', route => {
    hostRefreshCalls += 1
    return route.fulfill({ json: { changed: false } })
  })
  await page.goto(`/#/hermes/session/${sessionId}`)

  const card = page.locator('.mcp-app-result')
  await expect(card).toHaveCount(1)
  await expect(card).toHaveClass(/is-pip/)
  const view = card.frameLocator('iframe').frameLocator('iframe')
  await expect(view.getByText('3人', { exact: true })).toBeVisible()
  await expect.poll(() => debugEvents.some(event => event.event === 'app.tool.result' && event.code === 'edit_authorization_expired')).toBe(true)
  await expect(view.getByRole('button', { name: '重新展示草稿' })).toBeVisible()
  await expect.poll(() => contexts.some(context => context.params.structuredContent?.ticketDraft?.authorizationExpired === true)).toBe(true)
  const expiredContext = contexts.find(context => context.params.structuredContent?.ticketDraft?.authorizationExpired === true)
  expect(expiredContext.params.structuredContent.ticketDraft).toEqual({ draftId: 'dr_test', version: 2, authorizationExpired: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(view.getByRole('button', { name: '重新展示草稿' })).toBeVisible()
  await page.locator('.input-textarea').click()
  await expect(page.locator('.input-textarea')).toBeFocused()
  await view.locator('html').evaluate(element => { element.dataset.e2eInstance = 'original' })
  expect(await page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.emitted.some((item: any) => item.event === 'run'))).toBe(false)
  await view.getByRole('button', { name: '重新展示草稿' }).click()
  await expect.poll(() => appMessages.length).toBe(1)
  expect(appMessages[0].params.content[0].text).toBe('请重新展示当前工单草稿，暂不提交 Jira。')
  await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.emitted.some((item: any) => item.event === 'run'))).toBe(true)
  await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.sockets.some((socket: any) => socket.connected && socket.__listenerCount('tool.completed') > 0))).toBe(true)
  await page.waitForFunction(() => Boolean((window as any).__PW_CHAT_SOCKET__?.latest))
  const completed = buildOutboundRunEvent('tool.completed', {
    event: 'tool.completed', session_id: sessionId, run_id: 'draft-update', tool_call_id: 'render-v3',
    tool: 'mcp__ticket__render_ticket_card', output: JSON.stringify(rendered(3, '10人')),
  })
  await page.evaluate(({ sid, completed, args }) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.sockets.find((candidate: any) => candidate.connected && candidate.__listenerCount('tool.completed') > 0)
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'draft-update' })
    socket.__trigger('tool.started', {
      event: 'tool.started', session_id: sid, run_id: 'draft-update', tool_call_id: 'render-v3',
      tool: 'mcp__ticket__render_ticket_card', arguments: args,
    })
    socket.__trigger('tool.completed', completed)
  }, { sid: sessionId, completed, args: { action: 'prepare', result: { draft: draft(3, '10人') } } })
  latestVersion = 3

  await expect(view.getByText('10人', { exact: true })).toBeVisible()
  await expect(view.getByText('3人', { exact: true })).toHaveCount(0)
  await expect(view.getByRole('button', { name: '重新展示草稿' })).toHaveCount(0)
  await expect.poll(() => contexts.some(context => context.params.structuredContent?.ticketDraft?.authorizationExpired === false)).toBe(true)
  await expect(card).toHaveCount(1)
  await expect(view.locator('html')).toHaveAttribute('data-e2e-instance', 'original')
  await expect.poll(() => debugEvents.some(event => event.event === 'app.tool.request' && event.toolName === 'get_ticket_draft')).toBe(true)
  expect(debugEvents.some(event => event.event === 'card.ready' && event.version === 2)).toBe(true)
  expect(debugEvents.some(event => event.event === 'card.result' && event.version === 3)).toBe(true)
  expect(debugEvents.some(event => event.event === 'pip.claim')).toBe(true)
  expect(debugEvents.some(event => event.event === 'card.unmount')).toBe(false)
  expect(JSON.stringify(debugEvents)).not.toContain('test-token-')
  await page.waitForLoadState('networkidle')
  expect(hostRefreshCalls).toBe(0)
  await page.screenshot({ path: testInfo.outputPath('same-draft-latest-pip.png'), fullPage: true })
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

test('a plain user sees only the App card when a normal MCP tool has no UI', async ({ page }) => {
  await setup(page, true, appHtml, ticketModel, true)
  let identityResolved = false
  await page.route('**/api/hermes/mcp/apps/resolve', async route => {
    if (route.request().postDataJSON().toolName !== 'mcp__hermes_studio_use__hermes_studio_use_toolset') return route.fallback()
    identityResolved = true
    return route.fulfill({ status: 404, json: {
      code: 'mcp_app_not_found', error: 'The MCP tool does not declare an App resource',
    } })
  })
  await page.goto(`/#/hermes/session/${sessionId}`)
  const card = page.locator('.mcp-app-result')
  await expect(card.frameLocator('iframe').frameLocator('iframe').getByRole('heading', { name: '审批页面偶发 500' })).toBeVisible()
  expect(identityResolved).toBe(true)
  await expect(card).toHaveCount(1)
  await expect(page.locator('.result-error')).toHaveCount(0)
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
  await card.getByRole('button', { name: 'Pin', exact: true }).click()
  await expect(view.locator('html')).toHaveAttribute('data-display-mode', 'pip')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(view.getByRole('button', { name: '查看详情' })).toBeVisible()
  await expect.poll(() => view.locator('body').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
  await card.screenshot({ path: testInfo.outputPath('ticket-mobile.png') })
  await page.evaluate(() => localStorage.setItem('hermes_brightness', 'dark'))
  await page.reload()
  await expect(view.locator('html')).toHaveAttribute('data-theme', 'dark')
  await card.screenshot({ path: testInfo.outputPath('ticket-dark.png') })
})

test('edits a supplied ticket widget through standard tools/call and preserves conflicts', async ({ page }, testInfo) => {
  const widgetPath = process.env.MCP_APP_VISUAL_WIDGET_PATH
  test.skip(!widgetPath, 'Set MCP_APP_VISUAL_WIDGET_PATH to test the independently packaged plugin.')
  await page.setViewportSize({ width: 1280, height: 1100 })
  let version = 1
  let expectedBehavior = ''
  let impactScope = '测试用户 3 人'
  const contexts: any[] = []
  const appMessages: any[] = []
  const calls: any[] = []
  const fields = () => ({ title: '审批页面偶发 500', description: '审批提交失败', actual_behavior: '提交后提示 500', expected_behavior: expectedBehavior, impact_scope: impactScope, environment: '测试环境', product_module: '审批', attachment_notes: '' })
  const model = () => ({ ...ticketModel, kind: 'draft', heading: '工单草稿', status: '草稿 · 尚未提交', ticketId: null, ticketUrl: null,
    description: '审批提交失败', facts: [{ label: '影响范围', value: impactScope }, { label: '期望表现', value: expectedBehavior || '待补充' }], missing: expectedBehavior ? ['报告人'] : ['期望表现', '报告人'] })
  const meta = () => ({ ticketEdit: { editToken: 'test-draft-credential', draftId: 'dr_test', version, fields: fields() } })
  await setup(page, true, readFileSync(widgetPath!, 'utf8'), model(), false, meta())
  await page.route('**/api/hermes/mcp/apps/call-tool', async route => {
    const body = route.request().postDataJSON()
    calls.push(body)
    expect(body.sessionId).toBe(sessionId)
    expect(body.toolCallId).toBe('app-call')
    expect(body.profile).toBe('research')
    expect(body.toolName).toBe('mcp__ticket__render_ticket_card')
    if (body.params.name === 'update_ticket_draft') {
      if (body.params.arguments.version !== version) return route.fulfill({ json: {
        isError: true, content: [{ type: 'text', text: 'Draft version conflict' }], _meta: { ticketEditError: { code: 'version_conflict' } },
      } })
      expectedBehavior = body.params.arguments.fields.expected_behavior
      version++
    } else expect(body.params.name).toBe('get_ticket_draft')
    return route.fulfill({ json: { content: [{ type: 'text', text: 'saved' }], structuredContent: model(), _meta: meta() } })
  })
  await page.route('**/api/hermes/mcp/apps/model-context', async route => {
    contexts.push(route.request().postDataJSON())
    return route.fulfill({ json: {} })
  })
  await page.route('**/api/hermes/mcp/apps/message', async route => {
    const body = route.request().postDataJSON()
    appMessages.push(body)
    expect(body.sessionId).toBe(sessionId)
    expect(body.toolCallId).toBe('app-call')
    expect(body.profile).toBe('research')
    return route.fulfill({ json: { message: body.params.content[0].text } })
  })
  await page.goto('/#/hermes/session/' + sessionId)
  const card = page.locator('.mcp-app-result')
  const view = card.frameLocator('iframe').frameLocator('iframe')
  await expect.poll(() => calls.length).toBe(1)
  await expect.poll(() => contexts.length).toBeGreaterThan(0)
  await view.getByRole('button', { name: '查看详情' }).click()
  const input = view.locator('#ticket-edit-expected_behavior')
  await expect(input).toBeEnabled()
  await input.fill('审批正常提交')
  const contextsBeforeSave = contexts.length
  await view.locator('#ticket-save-draft').click()
  await expect(view.locator('#ticket-edit-status')).toContainText('草稿已保存')
  await expect.poll(() => contexts.length).toBe(contextsBeforeSave + 1)
  expect(calls[1].params.arguments.fields).toEqual({ expected_behavior: '审批正常提交' })
  expect(JSON.stringify(contexts)).toContain('审批正常提交')
  expect(JSON.stringify(contexts)).not.toContain('test-draft-credential')
  version++ // Another editor saved after this view read the draft.
  await input.fill('保留这次未保存的输入')
  await view.locator('#ticket-save-draft').click()
  await expect(view.locator('#ticket-edit-status')).toContainText('未保存的输入已保留')
  await expect(input).toHaveValue('保留这次未保存的输入')
  expect(contexts).toHaveLength(contextsBeforeSave + 1)
  await view.locator('#ticket-reload-draft').click()
  await expect(input).toHaveValue('审批正常提交')
  await card.screenshot({ path: testInfo.outputPath('ticket-interactive.png') })
  await page.reload()
  await view.getByRole('button', { name: '查看详情' }).click()
  await expect(input).toHaveValue('审批正常提交')
  const pinnedInstance = await view.locator('html').evaluate(element => {
    element.dataset.e2eInstance = crypto.randomUUID()
    return element.dataset.e2eInstance
  })
  impactScope = '10个人'
  version++
  await expect(view.getByText('10个人', { exact: true })).toBeVisible({ timeout: 8000 })
  await expect(view.locator('html')).toHaveAttribute('data-e2e-instance', pinnedInstance!)
  await expect(card).toHaveCount(1)
  const callsBeforePoll = calls.length
  expectedBehavior = 'AI 校验后补充的期望表现'
  version++
  await expect.poll(() => input.inputValue(), { timeout: 8000 }).toBe('AI 校验后补充的期望表现')
  await expect(card).toHaveCount(1)
  expect(calls.slice(callsBeforePoll).some(call => call.params.name === 'get_ticket_draft')).toBe(true)
  const runsBefore = await page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.filter((item: any) => item.event === 'run').length)
  const contextsBeforeContinue = contexts.length
  await view.getByRole('button', { name: '继续提交' }).click()
  await expect.poll(() => contexts.length).toBe(contextsBeforeContinue + 1)
  await expect.poll(async () => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.filter((item: any) => item.event === 'run').length)).toBe(runsBefore + 1)
  const continuation = await page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.filter((item: any) => item.event === 'run').at(-1)?.payload?.input || '')
  expect(continuation).toContain('最新草稿')
  expect(continuation).toContain('明确确认前不要提交 Jira')
  expect(appMessages).toHaveLength(1)
})
