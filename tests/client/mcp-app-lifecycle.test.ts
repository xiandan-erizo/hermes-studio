import { describe, expect, it } from 'vitest'
import { createMcpAppTeardown } from '@/utils/hermes/mcp-app-lifecycle'

describe('MCP App graceful teardown', () => {
  it('makes overlapping reloads wait for the same resource cleanup', async () => {
    const close = createMcpAppTeardown()
    const calls: string[] = []
    let finish!: () => void
    const bridge = {
      teardownResource: async () => {
        calls.push('teardown')
        await new Promise<void>(resolve => { finish = resolve })
        return {}
      },
      close: async () => { calls.push('closed') },
    }
    const first = close(bridge, true)
    let secondFinished = false
    const second = close(null, false).then(() => { secondFinished = true })
    await Promise.resolve()
    expect(secondFinished).toBe(false)
    expect(calls).toEqual(['teardown'])
    finish()
    await Promise.all([first, second])
    expect(secondFinished).toBe(true)
    expect(calls).toEqual(['teardown', 'closed'])
  })

  it('still closes the transport when a view rejects graceful cleanup', async () => {
    const calls: string[] = []
    const close = createMcpAppTeardown()
    await close({
      teardownResource: async () => { throw new Error('View disconnected') },
      close: async () => { calls.push('closed') },
    }, true)
    expect(calls).toEqual(['closed'])
  })
})
