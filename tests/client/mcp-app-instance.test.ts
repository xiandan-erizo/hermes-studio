// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import McpAppResultCard from '@/components/hermes/chat/McpAppResultCard.vue'
import type { McpAppInvocation } from '@/utils/hermes/mcp-app-result'

// Instance diagnostics are emitted before resolution. An unavailable resource
// keeps this lifecycle test independent of the external sandbox and bridge.
vi.mock('@/api/hermes/mcp', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/hermes/mcp')>(),
  resolveMcpApp: vi.fn().mockResolvedValue({ ok: false, code: 'mcp_app_not_found' }),
}))

const cards = new Set<VueWrapper>()

function unmountCard(card: VueWrapper): void {
  card.unmount()
  cards.delete(card)
}

afterEach(async () => {
  for (const card of cards) unmountCard(card)
  await flushPromises()
  localStorage.removeItem('hermes_mcp_app_debug')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('distinguishes simultaneous card instances and remounts of the same tool call in opt-in diagnostics', async () => {
  localStorage.setItem('hermes_mcp_app_debug', '1')
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  })
  const log = vi.spyOn(console, 'debug').mockImplementation(() => {})
  const pinia = createPinia()
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })
  const invocation: McpAppInvocation = {
    toolName: 'mcp__test__render_card', toolCallId: 'same-tool-call',
    toolArgs: {}, toolResult: { content: [] },
  }
  const mountCard = () => {
    const card = mount(McpAppResultCard, {
      props: { invocation, profile: 'test', sessionId: 'same-session' },
      global: { plugins: [pinia, i18n] },
    })
    cards.add(card)
    return card
  }
  const events = (event: string) => log.mock.calls
    .filter(([prefix]) => prefix === '[MCP App Debug]')
    .map(([, entry]) => JSON.parse(entry) as { event: string; instanceId?: string })
    .filter(entry => entry.event === event)

  const first = mountCard()
  const second = mountCard()
  await flushPromises()

  const initialMounts = events('card.mount')
  expect(initialMounts).toHaveLength(2)
  for (const entry of initialMounts) expect(entry.instanceId).toEqual(expect.any(String))
  expect(initialMounts[0].instanceId).not.toBe(initialMounts[1].instanceId)

  unmountCard(first)
  const remounted = mountCard()
  await flushPromises()

  const mounts = events('card.mount')
  expect(mounts).toHaveLength(3)
  expect(new Set(mounts.map(entry => entry.instanceId)).size).toBe(3)
  expect(events('card.unmount')).toEqual([
    expect.objectContaining({ instanceId: initialMounts[0].instanceId }),
  ])

  unmountCard(second)
  unmountCard(remounted)
  expect(events('card.unmount').map(entry => entry.instanceId)).toEqual(
    mounts.map(entry => entry.instanceId),
  )
})
