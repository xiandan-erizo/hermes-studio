import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockHermesApi } from './fixtures'

async function waitForRun(page: Page) {
  const handle = await page.waitForFunction(() => {
    const state = (window as any).__PW_CHAT_SOCKET__
    return state?.emitted?.find((item: any) => item.event === 'run')?.payload || null
  })
  return handle.jsonValue() as Promise<any>
}

const PLAIN_USER_ACCESS_KEY = [
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  Buffer.from(JSON.stringify({
    sub: '7',
    username: 'member',
    role: 'user',
    type: 'access',
    aud: 'hermes-web-ui',
    iat: 1_760_000_000,
    exp: 4_102_444_800,
  })).toString('base64url'),
  'plain-user-signature',
].join('.')

const plainSession = {
  id: 'plain-session',
  profile: 'research',
  source: 'cli',
  model: 'test-model',
  provider: 'test-provider',
  title: 'Plain user chat',
  preview: 'hello',
  started_at: 1_790_000_000,
  ended_at: null,
  last_active: 1_790_000_100,
  message_count: 1,
  tool_call_count: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  reasoning_tokens: 0,
  billing_provider: null,
  estimated_cost_usd: 0,
  actual_cost_usd: null,
  cost_status: '',
  workspace: '/workspace/profile-owned',
  category_id: null,
}

test('plain user chat exposes only profile selection, common slash shortcuts, and no workspace tools', async ({ page }) => {
  await authenticate(page, PLAIN_USER_ACCESS_KEY, 'research')
  await mockHermesApi(page, {
    sessions: [plainSession],
    profiles: [
      { name: 'research', active: true, model: 'test-model', gateway: 'test', alias: 'Research' },
    ],
  })

  await page.goto('/#/hermes/session/plain-session')

  await expect(page.locator('.header-session-title')).toHaveText('Plain user chat')
  await expect(page.locator('.workspace-badge')).toHaveCount(0)
  await expect(page.locator('.header-tool-toggle')).toHaveCount(0)

  const input = page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)')
  await input.fill('/')
  await expect(page.locator('.slash-command-name')).toHaveText(['/new', '/compact', '/skills'])

  await page.locator('.slash-command-item').filter({ hasText: '/new' }).click()
  const drawer = page.locator('.new-chat-drawer')
  await expect(drawer).toBeVisible()
  await expect(drawer.locator('.new-chat-field')).toHaveCount(1)
  await expect(drawer.locator('.new-chat-field')).toContainText('Profiles')
  await drawer.locator('.n-base-selection').click()
  await expect(page.locator('.n-base-select-option:visible')).toHaveText(['research'])
  await expect(drawer).not.toContainText('Agent')
  await expect(drawer).not.toContainText('Category')
  await expect(drawer).not.toContainText('Provider')
  await expect(drawer).not.toContainText('Workspace')

  await drawer.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page).toHaveURL(/#\/hermes\/session\//)
  await input.fill('hello from a plain user')
  await page.getByRole('button', { name: 'Send' }).click()

  const run = await waitForRun(page)
  expect(run).toMatchObject({
    profile: 'research',
    source: 'cli',
    model: 'test-model',
    provider: 'test-provider',
    workspace: undefined,
    category_id: null,
  })
})

test('plain user cannot create a chat when the backend returns no authorized Profiles', async ({ page }) => {
  await authenticate(page, PLAIN_USER_ACCESS_KEY)
  await mockHermesApi(page, { profiles: [] })

  await page.goto('/#/hermes/chat')
  await page.getByRole('button', { name: 'New Chat' }).click()

  const drawer = page.locator('.new-chat-drawer')
  await expect(drawer).toBeVisible()
  await expect(drawer.locator('.n-base-selection')).toHaveClass(/n-base-selection--disabled/)
  await expect(drawer.getByRole('button', { name: 'Create', exact: true })).toBeDisabled()
})
