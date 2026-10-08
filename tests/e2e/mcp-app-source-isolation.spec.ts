import { expect, test, type Locator, type Page } from '@playwright/test'
import { buildSync } from 'esbuild'
import { createSandboxDocument } from '../../packages/server/src/modules/studio/services/mcp-apps/sandbox'
import { buildOutboundRunEvent, buildResumeMessages } from '../../packages/server/src/modules/studio/services/chat-run/resume-payload'
import { authenticate, mockHermesApi } from './fixtures'

test.use({ channel: 'chromium', launchOptions: { args: ['--site-per-process'] } })

const sessionId = 'mcp-app-source-isolation'
const alphaTool = 'mcp__alpha__render_ticket_card'
const betaTool = 'mcp__beta__render_ticket_card'

const appScript = buildSync({
  stdin: {
    resolveDir: process.cwd(),
    contents: String.raw`
      import { App } from '@modelcontextprotocol/ext-apps/app-with-deps'
      const root = document.querySelector('#source-isolation-root')
      const inputs = []
      const results = []
      const app = new App({ name: 'e2e-source-isolation', version: '1.0.0' }, {}, { autoResize: false })
      root.dataset.instance = crypto.randomUUID()
      app.addEventListener('toolinput', input => {
        inputs.push(input.arguments)
        root.dataset.inputs = JSON.stringify(inputs)
      })
      app.addEventListener('toolresult', result => {
        results.push(result)
        root.dataset.results = JSON.stringify(results)
        root.querySelector('output').textContent = result.structuredContent.title
        app.sendSizeChanged({ height: 120 })
      })
      app.connect().then(() => { root.dataset.connected = 'true' })
        .catch(error => { root.textContent = error.message })
    `,
  },
  bundle: true, format: 'iife', platform: 'browser', write: false,
}).outputFiles[0].text

function resourceHtml(source: 'alpha' | 'beta') {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
    <main id="source-isolation-root" data-resource-source="${source}" data-resource-uri="ui://${source}/ticket-card.html">
      <h1>${source} resource</h1><output>loading</output>
    </main><script>${appScript}</script></body></html>`
}

function toolArgs(source: 'alpha' | 'beta', version: number) {
  return {
    action: 'prepare',
    origin: source,
    result: { draft: { draft_id: 'dr_shared', status: 'draft', version } },
  }
}

function toolResult(source: 'alpha' | 'beta', version: number) {
  return {
    content: [{ type: 'text', text: `${source} draft` }],
    structuredContent: { kind: 'draft', origin: source, title: `${source} version ${version}` },
    _meta: { ticketEdit: {
      draftId: 'dr_shared', version, editToken: `fake-${source}-private-v${version}`,
      fields: { title: `${source} title` },
    } },
  }
}

async function setup(page: Page) {
  await authenticate(page, undefined, 'research')
  const messages = buildResumeMessages([
    { id: 1, session_id: sessionId, role: 'user', content: 'Show both ticket Apps', timestamp: 1 },
    { id: 2, session_id: sessionId, role: 'assistant', content: '', timestamp: 2,
      tool_calls: [
        { id: 'alpha-v1', type: 'function', function: { name: alphaTool, arguments: JSON.stringify(toolArgs('alpha', 1)) } },
        { id: 'beta-v9', type: 'function', function: { name: betaTool, arguments: JSON.stringify(toolArgs('beta', 9)) } },
      ] },
    { id: 3, session_id: sessionId, role: 'tool', tool_call_id: 'alpha-v1', tool_name: alphaTool,
      content: JSON.stringify(toolResult('alpha', 1)), timestamp: 3 },
    { id: 4, session_id: sessionId, role: 'tool', tool_call_id: 'beta-v9', tool_name: betaTool,
      content: JSON.stringify(toolResult('beta', 9)), timestamp: 4 },
    { id: 5, session_id: sessionId, role: 'assistant', content: 'Both Apps are ready.', timestamp: 5, finish_reason: 'stop' },
  ])
  await page.addInitScript(({ sid, messages }) => {
    localStorage.setItem('hermes_show_tool_calls', 'false')
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = { [sid]: {
      session_id: sid, isWorking: false, events: [], messages,
    } }
  }, { sid: sessionId, messages })
  await mockHermesApi(page, { sessions: [{
    id: sessionId, profile: 'research', source: 'cli', model: 'test-model', provider: 'test-provider',
    title: 'MCP App source isolation', preview: '', started_at: 1, ended_at: null, last_active: 5,
    message_count: 5, tool_call_count: 2, workspace: '/workspace/research', category_id: null,
  }] })
  await page.route('**/api/studio/mcp-apps/sandbox?**', async route => {
    const url = new URL(route.request().url())
    const { html, policy } = createSandboxDocument(
      url.searchParams.get('parentOrigin') || '', JSON.parse(url.searchParams.get('csp') || '{}'),
    )
    await route.fulfill({ contentType: 'text/html', headers: { 'Content-Security-Policy': policy }, body: html })
  })
  await page.route('**/api/hermes/mcp/apps/resolve', route => {
    const { toolName } = route.request().postDataJSON()
    expect([alphaTool, betaTool]).toContain(toolName)
    const source = toolName === alphaTool ? 'alpha' : 'beta'
    return route.fulfill({ json: {
      ok: true,
      app: { id: source, name: `${source} App` },
      tool: {
        name: toolName, raw_name: 'render_ticket_card', server: source, description: 'Render ticket card',
        input_schema: { type: 'object' }, output_schema: { type: 'object' }, annotations: { readOnlyHint: true },
        _meta: { ui: { resourceUri: `ui://${source}/ticket-card.html` } },
      },
      resource: {
        uri: `ui://${source}/ticket-card.html`, mimeType: 'text/html;profile=mcp-app', text: resourceHtml(source),
        _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } },
      },
    } })
  })
}

async function notifications(root: Locator) {
  return root.evaluate(element => {
    const node = element as HTMLElement
    return {
      inputs: JSON.parse(node.dataset.inputs || '[]'),
      results: JSON.parse(node.dataset.results || '[]'),
    }
  })
}

test('isolates two MCP sources sharing a draft ID and updates only the existing source iframe', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1200 })
  await setup(page)
  await page.goto(`/#/hermes/session/${sessionId}`)

  const cards = page.locator('.mcp-app-result')
  await expect(cards).toHaveCount(2)
  const alphaCard = cards.filter({ has: page.locator('.mcp-app-title', { hasText: 'alpha App' }) })
  const betaCard = cards.filter({ has: page.locator('.mcp-app-title', { hasText: 'beta App' }) })
  const alphaView = alphaCard.frameLocator('iframe').frameLocator('iframe')
  const betaView = betaCard.frameLocator('iframe').frameLocator('iframe')
  const alphaRoot = alphaView.locator('#source-isolation-root')
  const betaRoot = betaView.locator('#source-isolation-root')
  await expect(alphaRoot).toHaveAttribute('data-connected', 'true')
  await expect(betaRoot).toHaveAttribute('data-connected', 'true')
  await expect(alphaRoot).toHaveAttribute('data-resource-uri', 'ui://alpha/ticket-card.html')
  await expect(betaRoot).toHaveAttribute('data-resource-uri', 'ui://beta/ticket-card.html')
  await expect(alphaView.getByRole('heading')).toHaveText('alpha resource')
  await expect(betaView.getByRole('heading')).toHaveText('beta resource')
  await expect(alphaView.locator('output')).toHaveText('alpha version 1')
  await expect(betaView.locator('output')).toHaveText('beta version 9')
  const alphaInstance = await alphaRoot.getAttribute('data-instance')
  const betaInstance = await betaRoot.getAttribute('data-instance')
  expect(alphaInstance).toBeTruthy()
  expect(betaInstance).toBeTruthy()
  expect(alphaInstance).not.toBe(betaInstance)

  const alphaInitial = await notifications(alphaRoot)
  const betaInitial = await notifications(betaRoot)
  expect(alphaInitial.inputs).toEqual([{
    action: 'prepare', origin: 'alpha', result: { draft: { draft_id: 'dr_shared', status: 'draft', version: 1 } },
  }])
  expect(betaInitial.inputs).toEqual([{
    action: 'prepare', origin: 'beta', result: { draft: { draft_id: 'dr_shared', status: 'draft', version: 9 } },
  }])
  expect(alphaInitial.results).toHaveLength(1)
  expect(betaInitial.results).toHaveLength(1)
  expect(alphaInitial.results[0]).toMatchObject({
    structuredContent: { origin: 'alpha', title: 'alpha version 1' },
    _meta: { ticketEdit: { draftId: 'dr_shared', version: 1, editToken: 'fake-alpha-private-v1' } },
  })
  expect(betaInitial.results[0]).toMatchObject({
    structuredContent: { origin: 'beta', title: 'beta version 9' },
    _meta: { ticketEdit: { draftId: 'dr_shared', version: 9, editToken: 'fake-beta-private-v9' } },
  })
  expect(JSON.stringify(alphaInitial)).not.toContain('fake-beta-private-')
  expect(JSON.stringify(betaInitial)).not.toContain('fake-alpha-private-')

  await page.locator('.input-textarea').fill('Update the alpha draft')
  await page.locator('.input-textarea').press('Enter')
  await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.emitted
    .some((item: any) => item.event === 'run'))).toBe(true)
  await page.waitForFunction(() => (window as any).__PW_CHAT_SOCKET__?.sockets
    .some((socket: any) => socket.connected && socket.__listenerCount('tool.completed') > 0))
  const completed = buildOutboundRunEvent('tool.completed', {
    event: 'tool.completed', session_id: sessionId, run_id: 'alpha-update', tool_call_id: 'alpha-v2',
    tool: alphaTool, output: JSON.stringify(toolResult('alpha', 2)),
  })
  await page.evaluate(({ sid, completed, tool, args }) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.sockets.find((candidate: any) =>
      candidate.connected && candidate.__listenerCount('tool.completed') > 0)
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'alpha-update' })
    socket.__trigger('tool.started', {
      event: 'tool.started', session_id: sid, run_id: 'alpha-update', tool_call_id: 'alpha-v2', tool, arguments: args,
    })
    socket.__trigger('tool.completed', completed)
  }, { sid: sessionId, completed, tool: alphaTool, args: toolArgs('alpha', 2) })

  await expect(alphaView.locator('output')).toHaveText('alpha version 2')
  await expect(cards).toHaveCount(2)
  await expect(alphaRoot).toHaveAttribute('data-instance', alphaInstance!)
  await expect(betaRoot).toHaveAttribute('data-instance', betaInstance!)
  await expect(betaView.locator('output')).toHaveText('beta version 9')
  const alphaUpdated = await notifications(alphaRoot)
  expect(alphaUpdated.results.at(-1)).toMatchObject({
    structuredContent: { origin: 'alpha', title: 'alpha version 2' },
    _meta: { ticketEdit: { draftId: 'dr_shared', version: 2, editToken: 'fake-alpha-private-v2' } },
  })
  expect(alphaUpdated.inputs.every((input: any) => input.origin === 'alpha')).toBe(true)
  expect(alphaUpdated.results.every((result: any) => result.structuredContent.origin === 'alpha')).toBe(true)
  expect(JSON.stringify(alphaUpdated)).not.toContain('fake-beta-private-')
  const betaUpdated = await notifications(betaRoot)
  expect(betaUpdated).toEqual(betaInitial)
  expect(JSON.stringify(betaUpdated)).not.toContain('fake-alpha-private-')
})
