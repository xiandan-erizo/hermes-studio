import { describe, expect, it } from 'vitest'
import { mcpAppUserMessage } from '@/utils/hermes/mcp-app-message'

describe('MCP App ui/message validation', () => {
  it('accepts one bounded user text block', () => {
    expect(mcpAppUserMessage({
      role: 'user',
      content: [{ type: 'text', text: '我已完成工单草稿修改，请继续提交前校验。' }],
    })).toBe('我已完成工单草稿修改，请继续提交前校验。')
  })

  it.each([
    undefined,
    {},
    { role: 'assistant', content: [{ type: 'text', text: 'no' }] },
    { role: 'user', content: [] },
    { role: 'user', content: [{ type: 'text', text: '' }] },
    { role: 'user', content: [{ type: 'text', text: 'ok' }, { type: 'text', text: 'again' }] },
    { role: 'user', content: [{ type: 'image', data: 'x' }] },
    { role: 'user', content: [{ type: 'text', text: 'x'.repeat(4097) }] },
  ])('rejects malformed or oversized messages', value => {
    expect(mcpAppUserMessage(value)).toBeNull()
  })
})
