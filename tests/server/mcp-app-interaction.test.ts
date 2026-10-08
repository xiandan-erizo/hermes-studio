import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), getSessionDetail: vi.fn(), canOperateSession: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => mocks)
vi.mock('../../packages/server/src/modules/studio/services/session-access', () => ({ canOperateSession: mocks.canOperateSession }))

import { requireMcpAppInvocation, validateMcpAppMessage, validateModelContext } from '../../packages/server/src/modules/studio/services/mcp-apps/interactions'

describe('MCP App invocation authorization', () => {
  beforeEach(() => {
    mocks.getSession.mockReturnValue({ id: 's1', profile: 'work', owner_user_id: 7 })
    mocks.canOperateSession.mockImplementation((user, session) => user?.id === session?.owner_user_id)
    mocks.getSessionDetail.mockReturnValue({ messages: [{ role: 'tool', tool_name: 'mcp__demo__render', tool_call_id: 'call1', content: JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }) }] })
  })
  const binding = { sessionId: 's1', toolCallId: 'call1', toolName: 'mcp__demo__render' }
  function assistantCall(toolCallId: string, toolName = binding.toolName) {
    return { role: 'assistant', tool_calls: [{ id: toolCallId, function: { name: toolName, arguments: JSON.stringify({ result: { draft: { draft_id: 'draft-1', version: 1 } } }) } }] }
  }
  function toolResult(toolCallId: string, content: string, toolName = binding.toolName) {
    return { role: 'tool', tool_name: toolName, tool_call_id: toolCallId, content }
  }
  it('accepts the recorded invocation only for its owner and profile', () => {
    expect(requireMcpAppInvocation({ id: 7 }, 'work', binding)).toEqual(binding)
    expect(() => requireMcpAppInvocation({ id: 8 }, 'work', binding)).toThrow()
    expect(() => requireMcpAppInvocation({ id: 7 }, 'other', binding)).toThrow()
    expect(() => requireMcpAppInvocation({ id: 7 }, 'work', { ...binding, toolName: 'mcp__other__render' })).toThrow()
    expect(() => requireMcpAppInvocation({ id: 7 }, 'work', { ...binding, toolCallId: 'not-recorded' })).toThrow()
  })
  it('fails closed for failed and ambiguous tool results', () => {
    mocks.getSessionDetail.mockReturnValue({ messages: [{ role: 'tool', tool_name: binding.toolName, tool_call_id: binding.toolCallId, content: '{"isError":true,"content":[]}' }] })
    expect(() => requireMcpAppInvocation({ id: 7 }, 'work', binding)).toThrow()
    mocks.getSessionDetail.mockReturnValue({ messages: Array(2).fill({ role: 'tool', tool_name: binding.toolName, tool_call_id: binding.toolCallId, content: '{"content":[]}' }) })
    expect(() => requireMcpAppInvocation({ id: 7 }, 'work', binding)).toThrow()
  })
  it.each([
    { state: 'pending', sourceName: binding.toolName, sourceResults: [] },
    { state: 'failed', sourceName: binding.toolName, sourceResults: ['{"isError":true,"content":[]}'] },
    { state: 'wrong tool name', sourceName: 'mcp__other__render', sourceResults: ['{"content":[]}'] },
    { state: 'duplicate successful results', sourceName: binding.toolName, sourceResults: ['{"content":[]}', '{"content":[]}'] },
    { state: 'duplicate success and failure', sourceName: binding.toolName, sourceResults: ['{"content":[]}', '{"isError":true,"content":[]}'] },
  ])('rejects a $state source despite a later successful call for the same draft', ({ sourceName, sourceResults }) => {
    mocks.getSessionDetail.mockReturnValue({ messages: [
      assistantCall('call1', sourceName),
      ...sourceResults.map(content => toolResult('call1', content, sourceName)),
      assistantCall('call2'),
      toolResult('call2', '{"content":[]}'),
    ] })
    expect(() => requireMcpAppInvocation({ id: 7 }, 'work', binding)).toThrow(expect.objectContaining({ status: 404 }))
  })
  it.each([
    ['duplicate successes', '{"content":[]}'],
    ['a success and failure', '{"isError":true,"content":[]}'],
  ])('rejects a pending source when a same-draft candidate has %s', (_state, duplicateResult) => {
    mocks.getSessionDetail.mockReturnValue({ messages: [
      assistantCall('call1'),
      assistantCall('call2'),
      toolResult('call2', '{"content":[]}'),
      toolResult('call2', duplicateResult),
    ] })
    expect(() => requireMcpAppInvocation({ id: 7 }, 'work', binding)).toThrow(expect.objectContaining({ status: 404 }))
    expect(() => requireMcpAppInvocation({ id: 7 }, 'work', { ...binding, toolCallId: 'call2' })).toThrow(expect.objectContaining({ status: 404 }))
  })
  it('keeps an older successful invocation bound to its own recorded call', () => {
    mocks.getSessionDetail.mockReturnValue({ messages: [
      assistantCall('call1'),
      toolResult('call1', '{"content":[]}'),
      assistantCall('call2'),
      toolResult('call2', '{"content":[]}'),
    ] })
    expect(requireMcpAppInvocation({ id: 7 }, 'work', binding)).toEqual({ sessionId: 's1', toolCallId: 'call1', toolName: 'mcp__demo__render' })
    expect(() => requireMcpAppInvocation({ id: 8 }, 'work', binding)).toThrow(expect.objectContaining({ status: 404 }))
    expect(() => requireMcpAppInvocation({ id: 7 }, 'other', binding)).toThrow(expect.objectContaining({ status: 404 }))
  })
  it('bounds model context and accepts only text/structured data', () => {
    expect(validateModelContext({ content: [{ type: 'text', text: 'draft saved' }], structuredContent: { version: 2 } })).toEqual({ content: [{ type: 'text', text: 'draft saved' }], structuredContent: { version: 2 } })
    expect(() => validateModelContext({ content: [{ type: 'image', data: 'secret' }] })).toThrow()
    expect(() => validateModelContext({ structuredContent: { text: 'x'.repeat(9000) } })).toThrow()
    expect(() => validateModelContext({ _meta: { forged: true } })).toThrow()
    expect(validateModelContext({ content: [{ type: 'text', text: 'saved', annotations: { audience: ['assistant'], priority: 0.5 }, _meta: { display: 'compact' } }] }).content?.[0].text).toBe('saved')
    expect(() => validateModelContext({ content: [{ type: 'text', text: 'saved', annotations: { priority: 3 } }] })).toThrow()
  })
  it('accepts one bounded user text message only', () => {
    expect(validateMcpAppMessage({ role: 'user', content: [{ type: 'text', text: 'continue' }] })).toBe('continue')
    expect(() => validateMcpAppMessage({ role: 'assistant', content: [{ type: 'text', text: 'no' }] })).toThrow()
    expect(() => validateMcpAppMessage({ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toThrow()
    expect(() => validateMcpAppMessage({ role: 'user', content: [{ type: 'text', text: 'x'.repeat(4097) }] })).toThrow()
  })
})
