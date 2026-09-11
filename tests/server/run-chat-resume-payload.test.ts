import { describe, expect, it } from 'vitest'
import {
  buildAppResumeMessagePage,
  buildOutboundToolMessage,
  buildOutboundRunEvent,
  buildResumeEvents,
  buildResumeMessagePage,
  buildResumeMessages,
  RESUME_MESSAGE_PAGE_LIMIT,
  RESUME_TOOL_RESULT_DISPLAY_LIMIT,
} from '../../packages/server/src/modules/studio/services/chat-run/resume-payload'

function message(overrides: Record<string, unknown>) {
  return {
    id: 1,
    session_id: 'session-1',
    role: 'tool',
    content: '',
    timestamp: 1,
    ...overrides,
  } as any
}

describe('buildResumeMessages', () => {
  const mcpToolName = 'mcp__ticket__render_ticket_card'
  const structuredResult = {
    result: '工单草稿已生成。'.repeat(60),
    structuredContent: {
      title: '审批页面偶发 500',
      facts: Array.from({ length: 60 }, (_, index) => ({ label: `字段 ${index}`, value: '完整内容'.repeat(60) })),
    },
    _meta: { 'example/view': { version: 1 } },
  }

  it.each([
    ['standard', { content: [{ type: 'text', text: structuredResult.result }], structuredContent: structuredResult.structuredContent, _meta: structuredResult._meta }],
    ['Hermes', structuredResult],
    ['wrapped', { output: JSON.stringify(structuredResult), exit_code: 0 }],
  ])('preserves the complete %s MCP result in history, live delivery, and event replay', (_name, result) => {
    const content = JSON.stringify(result)
    const persisted = message({ tool_name: mcpToolName, content })
    const event = { event: 'tool.completed', tool: mcpToolName, output: content, preview: structuredResult.result }
    expect(content.length).toBeGreaterThan(RESUME_TOOL_RESULT_DISPLAY_LIMIT)

    const [history] = buildResumeMessages([persisted])
    const live = buildOutboundRunEvent(event.event, event)
    const [replay] = buildResumeEvents([{ event: event.event, data: event }])

    expect(history.content).toBe(content)
    expect(live.output).toBe(content)
    expect(replay.data.output).toBe(content)
    expect(live.preview.length).toBeLessThanOrEqual(100)
    expect(persisted.content).toBe(content)
    expect(event.output).toBe(content)
  })

  it('retains the ordinary text limit for MCP calls without structured results and non-MCP calls', () => {
    for (const [toolName, result] of [
      [mcpToolName, { result: 'x'.repeat(4_000) }],
      ['terminal', structuredResult],
    ] as const) {
      const content = JSON.stringify(result)
      const [history] = buildResumeMessages([message({ tool_name: toolName, content })])
      const live = buildOutboundRunEvent('tool.completed', { tool: toolName, output: content })
      expect(history.content.length).toBeLessThanOrEqual(RESUME_TOOL_RESULT_DISPLAY_LIMIT)
      expect(live.output.length).toBeLessThanOrEqual(RESUME_TOOL_RESULT_DISPLAY_LIMIT)
    }
  })

  it('falls back to text for oversized MCP data instead of rendering partially truncated structured content', () => {
    // This is below 256 Ki characters but above 256 KiB in UTF-8.
    const content = JSON.stringify({ structuredContent: { title: '工单', description: '票'.repeat(100_000) } })
    const [history] = buildResumeMessages([message({ tool_name: mcpToolName, content })])
    const live = buildOutboundRunEvent('tool.completed', { tool: mcpToolName, output: content })
    for (const output of [history.content, live.output]) {
      expect(output.length).toBeLessThanOrEqual(RESUME_TOOL_RESULT_DISPLAY_LIMIT)
      expect(output).toContain('truncated')
      expect(() => JSON.parse(output)).toThrow()
    }
  })

  it('returns only the latest display page without trimming runtime history', () => {
    const history = Array.from({ length: 1_000 }, (_, index) => message({
      id: index + 1,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message-${index + 1}`,
    }))

    const page = buildResumeMessagePage(history)

    expect(page.messages).toHaveLength(RESUME_MESSAGE_PAGE_LIMIT)
    expect(page.messages[0].id).toBe(851)
    expect(page.messages.at(-1)?.id).toBe(1_000)
    expect(page.messageTotal).toBe(1_000)
    expect(page.messageLoadedCount).toBe(RESUME_MESSAGE_PAGE_LIMIT)
    expect(page.hasMoreBefore).toBe(true)
    expect(history).toHaveLength(1_000)
    expect(history[0].id).toBe(1)
  })

  it('keeps the persisted hidden prefix in resume pagination metadata', () => {
    const inMemoryWindow = Array.from({ length: 160 }, (_, index) => message({
      id: 851 + index,
      role: 'user',
      content: `message-${851 + index}`,
    }))

    const page = buildResumeMessagePage(inMemoryWindow, {
      messageTotal: 1_000,
      messageStateBaselineCount: 150,
      limit: 150,
    })

    expect(page.messages).toHaveLength(150)
    expect(page.messages[0].id).toBe(861)
    expect(page.messageTotal).toBe(1_010)
    expect(page.messageLoadedCount).toBe(150)
    expect(page.hasMoreBefore).toBe(true)
  })

  it('keeps raw pagination counts when display normalization omitted stored rows', () => {
    const normalizedWindow = Array.from({ length: 145 }, (_, index) => message({
      id: 856 + index,
      role: 'user',
      content: `message-${856 + index}`,
    }))

    const page = buildResumeMessagePage(normalizedWindow, {
      messageTotal: 1_000,
      messageStateBaselineCount: 145,
      limit: 150,
    })

    expect(page.messages).toHaveLength(145)
    expect(page.messageTotal).toBe(1_000)
    expect(page.messageLoadedCount).toBe(150)
    expect(page.hasMoreBefore).toBe(true)
  })

  it('omits App messages when the supplied cache id still matches', () => {
    const page = buildResumeMessagePage([
      message({ id: 1, role: 'user', content: 'hello' }),
      message({ id: 2, role: 'assistant', content: 'world' }),
    ])

    const initial = buildAppResumeMessagePage(page, '')
    const cached = buildAppResumeMessagePage(page, initial.id)

    expect(initial).toMatchObject({
      messages: page.messages,
      messagesCached: false,
    })
    expect(initial.id).toMatch(/^[a-f0-9]{32}$/)
    expect(cached).toEqual({
      id: initial.id,
      messagesCached: true,
      messageTotal: 2,
      messageLoadedCount: 2,
      messagePageLimit: RESUME_MESSAGE_PAGE_LIMIT,
      hasMoreBefore: false,
    })
  })

  it('returns a new App page when cached message content changed under the same message id', () => {
    const before = buildAppResumeMessagePage(buildResumeMessagePage([
      message({ id: 7, role: 'assistant', content: 'partial' }),
    ]), '')
    const after = buildAppResumeMessagePage(buildResumeMessagePage([
      message({ id: 7, role: 'assistant', content: 'complete' }),
    ]), before.id)

    expect(after.messagesCached).toBe(false)
    expect(after.id).not.toBe(before.id)
    expect(after.messages?.[0].content).toBe('complete')
  })

  it('invalidates the App page cache when only its workspace diff sidecar changes', () => {
    const page = buildResumeMessagePage([
      message({ id: 7, role: 'assistant', content: 'complete' }),
    ])
    const before = buildAppResumeMessagePage({
      ...page,
      workspaceRunChanges: [],
    }, '')
    const after = buildAppResumeMessagePage({
      ...page,
      workspaceRunChanges: [{ change_id: 'change-1', assistant_message_id: '7' } as any],
    }, before.id)

    expect(after.messagesCached).toBe(false)
    expect(after.id).not.toBe(before.id)
    expect(after.workspaceRunChanges).toEqual([
      expect.objectContaining({ change_id: 'change-1', assistant_message_id: '7' }),
    ])
  })

  it('truncates only the outbound tool result without mutating session history', () => {
    const completeResult = 'x'.repeat(4_000)
    const persisted = message({ content: completeResult })
    const history = [persisted]

    const outbound = buildResumeMessages(history)

    expect(outbound).not.toBe(history)
    expect(outbound[0]).not.toBe(persisted)
    expect(outbound[0].content).toContain('... (truncated)')
    expect(outbound[0].content.length).toBe(RESUME_TOOL_RESULT_DISPLAY_LIMIT)
    expect((outbound[0] as any).content_truncated).toBe(true)
    expect((outbound[0] as any).content_original_length).toBe(completeResult.length)
    expect(history[0]).toBe(persisted)
    expect(history[0].content).toBe(completeResult)
  })

  it('keeps large JSON valid so the frontend can retain structured rendering', () => {
    const completeResult = JSON.stringify({
      status: 'ok',
      rows: Array.from({ length: 200 }, (_, index) => ({ index, value: 'x'.repeat(80) })),
    })

    const [outbound] = buildResumeMessages([message({ content: completeResult })])
    const parsed = JSON.parse(outbound.content)

    expect(parsed.status).toBe('ok')
    expect(outbound.content.length).toBeLessThanOrEqual(RESUME_TOOL_RESULT_DISPLAY_LIMIT)
    expect(outbound.content).toContain('truncated')
  })

  it('does not alter normal chat messages or short tool results', () => {
    const user = message({ role: 'user', content: 'hello' })
    const assistant = message({ role: 'assistant', content: 'world' })
    const tool = message({ content: '{"ok":true}' })

    const outbound = buildResumeMessages([user, assistant, tool])

    expect(outbound[0]).toBe(user)
    expect(outbound[1]).toBe(assistant)
    expect(outbound[2]).toBe(tool)
  })

  it('bounds display_content independently while preserving the original field', () => {
    const completeDisplayContent = 'display-'.repeat(400)
    const persisted = message({ content: 'small', display_content: completeDisplayContent })

    const [outbound] = buildResumeMessages([persisted])

    expect(outbound.display_content).toContain('... (truncated)')
    expect((outbound as any).display_content_truncated).toBe(true)
    expect(persisted.display_content).toBe(completeDisplayContent)
  })

  it('keeps unified diffs intact to match the existing Studio display behavior', () => {
    const diff = [
      'diff --git a/file.ts b/file.ts',
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1 +1 @@',
      ...Array.from({ length: 300 }, () => '-before\n+after'),
    ].join('\n')
    const persisted = message({ content: diff })

    const [outbound] = buildResumeMessages([persisted])

    expect(outbound).toBe(persisted)
    expect(outbound.content).toBe(diff)
  })

  it('truncates the live WebSocket tool event without mutating the internal event', () => {
    const completeOutput = 'live-result-'.repeat(400)
    const internal = {
      event: 'tool.completed',
      session_id: 'session-1',
      output: completeOutput,
      preview: completeOutput,
    }

    const outbound = buildOutboundRunEvent('tool.completed', internal)

    expect(outbound).not.toBe(internal)
    expect(outbound.output.length).toBe(RESUME_TOOL_RESULT_DISPLAY_LIMIT)
    expect(outbound.output_truncated).toBe(true)
    expect(outbound.output_original_length).toBe(completeOutput.length)
    expect(outbound.preview.length).toBe(100)
    expect(internal.output).toBe(completeOutput)
    expect(internal.preview).toBe(completeOutput)
  })

  it('truncates replayed live events without changing state.events', () => {
    const completeOutput = 'event-'.repeat(800)
    const stateEvents = [{
      event: 'tool.failed',
      data: { event: 'tool.failed', output: completeOutput, error: 'failed' },
    }]

    const outbound = buildResumeEvents(stateEvents)

    expect(outbound[0]).not.toBe(stateEvents[0])
    expect(outbound[0].data.output.length).toBe(RESUME_TOOL_RESULT_DISPLAY_LIMIT)
    expect(stateEvents[0].data.output).toBe(completeOutput)
  })

  it('computes pending interaction time remaining on the server when replaying a run', () => {
    const requestedAt = 1_000_000
    const stateEvents = [
      {
        event: 'approval.requested',
        data: { event: 'approval.requested', approval_id: 'approval-1', timeout_ms: 300_000, requested_at: requestedAt },
      },
      {
        event: 'clarify.requested',
        data: { event: 'clarify.requested', clarify_id: 'clarify-1', timeout_ms: 120_000, requested_at: requestedAt },
      },
    ]

    const outbound = buildResumeEvents(stateEvents, requestedAt + 45_000)

    expect(outbound[0].data.remaining_timeout_ms).toBe(255_000)
    expect(outbound[1].data.remaining_timeout_ms).toBe(75_000)
    expect(stateEvents[0].data).not.toHaveProperty('remaining_timeout_ms')
  })

  it('never returns a negative pending interaction countdown', () => {
    const outbound = buildResumeEvents([{
      event: 'approval.requested',
      data: { event: 'approval.requested', approval_id: 'approval-1', timeout_ms: 1_000, requested_at: 10_000 },
    }], 15_000)

    expect(outbound[0].data.remaining_timeout_ms).toBe(0)
  })

  it('reuses the display boundary for group-chat tool rows while preserving selected payload tools', () => {
    const completeResult = 'group-result-'.repeat(400)
    const persisted = {
      id: 'group-tool-1',
      roomId: 'room-1',
      role: 'tool',
      tool_name: 'read_file',
      content: completeResult,
    }

    const outbound = buildOutboundToolMessage(persisted)
    const workspaceDiff = buildOutboundToolMessage(
      { ...persisted, tool_name: 'workspace_diff' },
      { preserveToolNames: ['workspace_diff'] },
    )

    expect(outbound).not.toBe(persisted)
    expect(outbound.content).toHaveLength(RESUME_TOOL_RESULT_DISPLAY_LIMIT)
    expect(outbound.content_truncated).toBe(true)
    expect(outbound.content_original_length).toBe(completeResult.length)
    expect(persisted.content).toBe(completeResult)
    expect(workspaceDiff.content).toBe(completeResult)
  })
})
