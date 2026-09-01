// @vitest-environment jsdom
import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const push = vi.fn()

vi.mock('@/api/client', () => ({
  isStoredSuperAdmin: () => false,
  isStoredUser: () => true,
}))

vi.mock('@/composables/useSessionSearch', () => ({
  useSessionSearch: () => ({ openSessionSearch: vi.fn() }),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  NTooltip: defineComponent({
    template: '<div><slot name="trigger" /><slot /></div>',
  }),
}))

import PageSidebarNav from '@/components/layout/PageSidebarNav.vue'
import PageSidebarFooter from '@/components/layout/PageSidebarFooter.vue'

describe('plain user page sidebar', () => {
  beforeEach(() => {
    push.mockReset()
  })

  it('only exposes the single-chat and history destinations', () => {
    const wrapper = mount(PageSidebarNav, {
      props: { active: 'chat' },
    })

    const labels = wrapper.findAll('button').map((button) => {
      const text = button.text().trim()
      return text || button.attributes('aria-label') || ''
    }).filter(Boolean)

    expect(labels).toEqual([
      'chat.newChat',
      'sidebar.singleChat',
      'sidebar.history',
    ])
  })

  it('exposes logout instead of settings to plain users', () => {
    const wrapper = mount(PageSidebarFooter)

    expect(wrapper.text()).toContain('sidebar.logout')
    expect(wrapper.text()).not.toContain('sidebar.settings')
  })
})
