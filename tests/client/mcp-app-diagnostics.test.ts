// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { traceMcpApp } from '@/utils/hermes/mcp-app-diagnostics'

afterEach(() => {
  localStorage.removeItem('hermes_mcp_app_debug')
  vi.restoreAllMocks()
})

it('emits no MCP App diagnostics until the browser opt-in is enabled', () => {
  const log = vi.spyOn(console, 'debug').mockImplementation(() => {})
  traceMcpApp('poll.result', { instanceId: 'app-1', version: 3 })
  expect(log).not.toHaveBeenCalled()
})

it('logs only bounded diagnostic fields, never tool arguments or edit credentials', () => {
  localStorage.setItem('hermes_mcp_app_debug', '1')
  const log = vi.spyOn(console, 'debug').mockImplementation(() => {})
  traceMcpApp('poll.result', {
    instanceId: 'app-1', draftId: 'dr_test', version: 3, outcome: 'error', code: 'edit_authorization_expired',
    editToken: 'private-token', description: 'private ticket content',
  } as any)

  expect(log).toHaveBeenCalledOnce()
  expect(log.mock.calls[0][0]).toBe('[MCP App Debug]')
  expect(JSON.parse(log.mock.calls[0][1])).toEqual({
    event: 'poll.result', instanceId: 'app-1', draftId: 'dr_test', version: 3, outcome: 'error', code: 'edit_authorization_expired',
  })
})
