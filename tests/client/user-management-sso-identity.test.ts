// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const authApiMock = vi.hoisted(() => ({
  createManagedUser: vi.fn(),
  deleteManagedUser: vi.fn(),
  fetchManagedUsers: vi.fn(),
  updateManagedUser: vi.fn(),
}))

vi.mock('@/api/studio/auth', () => authApiMock)
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('naive-ui', () => ({
  NButton: defineComponent({ template: '<button><slot /></button>' }),
  NDataTable: defineComponent({
    props: ['columns', 'data'],
    setup(props) {
      return () => h('table', {}, (props.data as any[]).map(row => h('tr', {}, (props.columns as any[]).map(column => h('td', {}, [
        column.render ? column.render(row) : String(row[column.key] ?? ''),
      ])))))
    },
  }),
  NForm: defineComponent({ template: '<form><slot /></form>' }),
  NFormItem: defineComponent({ template: '<div><slot /></div>' }),
  NInput: defineComponent({ template: '<input />' }),
  NModal: defineComponent({ template: '<div><slot /><slot name="action" /></div>' }),
  NPopconfirm: defineComponent({ template: '<div><slot /><slot name="trigger" /></div>' }),
  NSelect: defineComponent({ inheritAttrs: false, template: '<div />' }),
  NSpace: defineComponent({ template: '<span><slot /></span>' }),
  NTag: defineComponent({ template: '<span><slot /></span>' }),
  useMessage: () => ({ success: vi.fn(), error: vi.fn() }),
}))

import UserManagementSettings from '@/components/hermes/settings/UserManagementSettings.vue'

describe('UserManagementSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authApiMock.fetchManagedUsers.mockResolvedValue({
      users: [{
        id: 7,
        username: 'bob',
        email: 'bob@example.com',
        display_name: 'Bob Example',
        role: 'user',
        status: 'active',
        profiles: ['default'],
        default_profile: 'default',
        created_at: 1,
        updated_at: 1,
        last_login_at: null,
      }],
      profiles: ['default'],
    })
  })

  it('renders mapped SSO display name and email in the username table cell', async () => {
    const wrapper = mount(UserManagementSettings)
    await flushPromises()

    const usernameCell = wrapper.find('td')
    expect(usernameCell.text()).toContain('bob')
    expect(usernameCell.text()).toContain('Bob Example')
    expect(usernameCell.text()).toContain('bob@example.com')
  })
})
