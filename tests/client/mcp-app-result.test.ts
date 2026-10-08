// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { reactive } from 'vue'

import type { Message } from '@/stores/hermes/chat'
import {
  buildMcpAppSrcdoc,
  includeMcpAppResults,
  normalizeMcpCallToolResult,
  safeMcpAppExternalUrl,
} from '@/utils/hermes/mcp-app-result'

const structuredContent = {
  schemaVersion: 1,
  kind: 'receipt',
  title: 'Ticket created',
}

function draftMessage(id: string, toolName: string, draftId: string, version: number): Message {
  return {
    id, role: 'tool', content: '', timestamp: version, toolStatus: 'done',
    toolName, toolCallId: `call-${id}`,
    toolArgs: { action: 'prepare', result: { draft: { draft_id: draftId, version, status: 'draft' } } },
    toolResult: {
      content: [],
      structuredContent: { kind: 'draft', title: id },
      _meta: {
        ui: { resourceUri: `ui://${id}/card.html` },
        ticketEdit: { version, editToken: `fake-${id}-token` },
      },
    },
  }
}

describe('MCP App tool results', () => {
  it('normalizes Hermes MCP output wrappers into a standard CallToolResult', () => {
    const raw = JSON.stringify({
      output: JSON.stringify({
        result: 'Ticket CYXQ-123 created',
        structuredContent,
        _meta: { 'com.example/source': 'ticket' },
      }),
      exit_code: 0,
    })

    expect(normalizeMcpCallToolResult(raw)).toEqual({
      content: [{ type: 'text', text: 'Ticket CYXQ-123 created' }],
      structuredContent,
      _meta: { 'com.example/source': 'ticket' },
    })
  })

  it('does not create an App row for failed, running, or non-MCP tools', () => {
    const base: Message = {
      id: 'tool-1',
      role: 'tool',
      content: '',
      timestamp: 1,
      toolName: 'mcp__ticket__render_ticket_card',
      toolArgs: { action: 'submit' },
      toolResult: { result: 'done', structuredContent },
      toolStatus: 'done',
    }
    const eligible = includeMcpAppResults([base])
    expect(eligible.map(message => message.id)).toEqual(['tool-1', 'mcp-app:tool-1'])
    expect(eligible[1]).toMatchObject({
      systemType: 'mcp-app',
      mcpApp: {
        toolName: 'mcp__ticket__render_ticket_card',
        toolArgs: { action: 'submit' },
        toolResult: { structuredContent },
      },
    })

    for (const message of [
      { ...base, toolStatus: 'running' as const },
      { ...base, toolStatus: 'error' as const },
      { ...base, toolName: 'terminal' },
      { ...base, toolResult: { isError: true, structuredContent } },
    ]) {
      expect(includeMcpAppResults([message])).toEqual([message])
    }
  })

  it('resolves UI candidates with text-only MCP results without requiring structuredContent', () => {
    for (const toolResult of [
      { content: [{ type: 'text', text: 'Ticket draft ready' }] },
      { result: 'Ticket draft ready' },
    ]) {
      const rows = includeMcpAppResults([{
        id: 'text-app', role: 'tool', content: '', timestamp: 1,
        toolName: 'mcp__ticket__render_ticket_card', toolStatus: 'done', toolResult,
      }])
      expect(rows).toHaveLength(2)
      expect(rows[1].mcpApp?.toolResult.content).toEqual([{ type: 'text', text: 'Ticket draft ready' }])
    }
  })

  it.each([
    ['different MCP servers', 'mcp__beta__render_ticket_card'],
    ['different tools on one MCP server', 'mcp__alpha__nested__render_ticket_card'],
  ])('keeps shared draft IDs and private results separate for %s', (_, secondToolName) => {
    const rows = includeMcpAppResults([
      draftMessage('alpha-v2', 'mcp__alpha__render_ticket_card', 'dr_shared', 2),
      draftMessage('other-v7', secondToolName, 'dr_shared', 7),
      draftMessage('alpha-v3', 'mcp__alpha__render_ticket_card', 'dr_shared', 3),
    ])

    expect(rows.filter(row => row.systemType === 'mcp-app')).toMatchObject([
      {
        id: 'mcp-app:alpha-v2',
        mcpApp: {
          toolName: 'mcp__alpha__render_ticket_card', toolCallId: 'call-alpha-v2',
          draftId: 'dr_shared', presentationVersion: 3,
          toolArgs: { result: { draft: { version: 2 } } },
          toolResult: {
            structuredContent: { kind: 'draft', title: 'alpha-v3' },
            _meta: {
              ui: { resourceUri: 'ui://alpha-v3/card.html' },
              ticketEdit: { version: 3, editToken: 'fake-alpha-v3-token' },
            },
          },
        },
      },
      {
        id: 'mcp-app:other-v7',
        mcpApp: {
          toolName: secondToolName, toolCallId: 'call-other-v7',
          draftId: 'dr_shared', presentationVersion: 7,
          toolResult: {
            structuredContent: { kind: 'draft', title: 'other-v7' },
            _meta: {
              ui: { resourceUri: 'ui://other-v7/card.html' },
              ticketEdit: { version: 7, editToken: 'fake-other-v7-token' },
            },
          },
        },
      },
    ])
  })

  it('keeps different drafts from the same MCP tool separate', () => {
    const rows = includeMcpAppResults([
      draftMessage('first', 'mcp__alpha__render_ticket_card', 'dr_first', 2),
      draftMessage('second', 'mcp__alpha__render_ticket_card', 'dr_second', 3),
    ])

    expect(rows.filter(row => row.systemType === 'mcp-app')).toMatchObject([
      { id: 'mcp-app:first', mcpApp: { draftId: 'dr_first', toolResult: { _meta: { ticketEdit: { editToken: 'fake-first-token' } } } } },
      { id: 'mcp-app:second', mcpApp: { draftId: 'dr_second', toolResult: { _meta: { ticketEdit: { editToken: 'fake-second-token' } } } } },
    ])
  })

  it('keeps tool and draft identities separate when they contain delimiters', () => {
    const rows = includeMcpAppResults([
      draftMessage('first', 'mcp__alpha__render_ticket_card', 'dr_first:mcp__beta__render_ticket_card:dr_second', 2),
      draftMessage('second', 'mcp__alpha__render_ticket_card:dr_first:mcp__beta__render_ticket_card', 'dr_second', 3),
    ])

    expect(rows.filter(row => row.systemType === 'mcp-app')).toMatchObject([
      { id: 'mcp-app:first', mcpApp: { toolName: 'mcp__alpha__render_ticket_card', toolResult: { structuredContent: { title: 'first' } } } },
      { id: 'mcp-app:second', mcpApp: { toolName: 'mcp__alpha__render_ticket_card:dr_first:mcp__beta__render_ticket_card', toolResult: { structuredContent: { title: 'second' } } } },
    ])
  })

  it('keeps one current App for repeated renders of the same draft', () => {
    const draft = (version: number) => ({ draft_id: 'dr_test', version, status: 'draft', extracted_fields: { impact_scope: version === 2 ? '3人' : '10人' } })
    const message = (id: string, version: number): Message => ({
      id,
      role: 'tool',
      content: '',
      timestamp: version,
      toolName: 'mcp__ticket__render_ticket_card',
      toolCallId: `call-${id}`,
      toolArgs: { action: 'prepare', result: { draft: draft(version) } },
      toolResult: { structuredContent: { kind: 'draft', facts: [{ label: '影响范围', value: draft(version).extracted_fields.impact_scope }] }, content: [] },
      toolStatus: 'done',
    })

    const rows = includeMcpAppResults([message('v2', 2), message('v3', 3)])

    expect(rows.map(row => row.id)).toEqual(['v2', 'mcp-app:v2', 'v3'])
    expect(rows[1].mcpApp?.toolCallId).toBe('call-v2')
    expect(rows[1].mcpApp?.toolResult.structuredContent).toMatchObject({ facts: [{ label: '影响范围', value: '10人' }] })
  })

  it('refreshes same-version private metadata without changing the oldest App binding', () => {
    const rows = includeMcpAppResults([
      draftMessage('expired', 'mcp__alpha__render_ticket_card', 'dr_shared', 3),
      draftMessage('fresh', 'mcp__alpha__render_ticket_card', 'dr_shared', 3),
    ])

    expect(rows.map(row => row.id)).toEqual(['expired', 'mcp-app:expired', 'fresh'])
    expect(rows[1].mcpApp).toMatchObject({
      toolCallId: 'call-expired', presentationVersion: 3,
      toolResult: { _meta: { ticketEdit: { version: 3, editToken: 'fake-fresh-token' } } },
    })
  })

  it('prefers the higher draft version over a later stale render', () => {
    const draft = (version: number) => ({ draft_id: 'dr_test', version, status: 'draft', extracted_fields: { impact_scope: `${version}人` } })
    const rendered = (id: string, version: number, impact: string): Message => ({
      id, role: 'tool', content: '', timestamp: version, toolStatus: 'done',
      toolName: 'mcp__ticket__render_ticket_card', toolCallId: `call-${id}`,
      toolArgs: { action: 'prepare', result: { draft: draft(version) } },
      toolResult: { structuredContent: { kind: 'draft', facts: [{ label: '影响范围', value: impact }] }, content: [] },
    })
    const refreshed = rendered('v4', 4, '12人')

    const rows = includeMcpAppResults([refreshed, rendered('v3', 3, '10人')])

    expect(rows.map(row => row.id)).toEqual(['v4', 'mcp-app:v4', 'v3'])
    expect(rows[1].mcpApp?.presentationVersion).toBe(4)
    expect(rows[1].mcpApp?.toolResult.structuredContent).toMatchObject({ facts: [{ label: '影响范围', value: '12人' }] })
  })

  it('preserves metadata and JSON-looking text in Hermes content-only results', () => {
    for (const result of ['Ticket ready', '{"ticketId":"T-7"}']) {
      expect(normalizeMcpCallToolResult({ result, _meta: { viewState: { id: 7 } } })).toEqual({
        content: [{ type: 'text', text: result }], _meta: { viewState: { id: 7 } },
      })
    }
  })

  it('removes Vue proxies before values cross the iframe postMessage boundary', () => {
    const tool = reactive<Message>({
      id: 'live-tool',
      role: 'tool',
      content: '',
      timestamp: 1,
      toolName: 'mcp__ticket__render_ticket_card',
      toolArgs: { action: 'submit', nested: { id: 7 } },
      toolResult: { result: 'done', structuredContent },
      toolStatus: 'done',
    })
    const projected = includeMcpAppResults([tool])
    expect(() => structuredClone(projected[1].mcpApp?.toolArgs)).not.toThrow()
    expect(() => structuredClone(projected[1].mcpApp?.toolResult)).not.toThrow()
  })

  it('injects a restrictive CSP while preserving the MCP App script', () => {
    const srcdoc = buildMcpAppSrcdoc(
      '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body><script>window.ready=true</script></body></html>',
      {
        ui: {
          csp: {
            connectDomains: ['https://api.example.test'],
            resourceDomains: ['https://cdn.example.test'],
            frameDomains: [],
            baseUriDomains: [],
          },
        },
      },
    )
    const parsed = new DOMParser().parseFromString(srcdoc, 'text/html')
    const policies = parsed.querySelectorAll('meta[http-equiv="Content-Security-Policy"]')
    expect(policies).toHaveLength(1)
    const policy = policies[0].getAttribute('content') || ''
    expect(policy).toContain("default-src 'none'")
    expect(policy).toContain("script-src 'unsafe-inline' https://cdn.example.test")
    expect(policy).toContain('connect-src https://api.example.test')
    expect(policy).toContain("frame-src 'none'")
    expect(policy).toContain("form-action 'none'")
    expect(parsed.querySelector('script')?.textContent).toContain('window.ready=true')
  })

  it('accepts only credential-free HTTP links for host-mediated navigation', () => {
    expect(safeMcpAppExternalUrl('https://jira.example.test/browse/CYXQ-1')).toBe('https://jira.example.test/browse/CYXQ-1')
    for (const value of [
      'javascript:alert(1)',
      'data:text/html,x',
      '/relative',
      'https://user:secret@example.test/',
      'https://example.test/\nnext',
    ]) expect(safeMcpAppExternalUrl(value)).toBeNull()
  })
})
