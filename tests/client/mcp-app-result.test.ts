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
