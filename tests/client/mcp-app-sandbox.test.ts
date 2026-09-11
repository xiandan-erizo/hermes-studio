import { describe, expect, it } from 'vitest'
import { buildSandboxUrl } from '@/utils/hermes/mcp-app-sandbox'

describe('MCP App sandbox origin', () => {
  it('uses an explicit isolated origin and transmits resource policy without credentials', () => {
    const url = new URL(buildSandboxUrl('https://studio.example.test', 'https://views.example.test', {
      ui: { csp: { connectDomains: ['https://api.example.test'] } },
    }))
    expect(url.origin).toBe('https://views.example.test')
    expect(url.searchParams.get('parentOrigin')).toBe('https://studio.example.test')
    expect(JSON.parse(url.searchParams.get('csp')!)).toEqual({ connectDomains: ['https://api.example.test'] })
  })
  it('uses a distinct loopback origin without requiring a deployment setting', () => {
    expect(new URL(buildSandboxUrl('http://127.0.0.1:4173', undefined, {})).origin).toBe('http://localhost:4173')
    expect(new URL(buildSandboxUrl('http://localhost:4173', undefined, {})).origin).toBe('http://127.0.0.1:4173')
  })
  it('rejects same-origin, missing hosted configuration, credentials, and mixed content', () => {
    for (const configured of [undefined, 'https://studio.example.test', 'http://views.example.test', 'https://user:pass@views.example.test', 'https://views.example.test/path']) {
      expect(() => buildSandboxUrl('https://studio.example.test', configured, {})).toThrow()
    }
  })
})
