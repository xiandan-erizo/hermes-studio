import { expect, it, vi } from 'vitest'
import { claimMcpAppPip } from '../../packages/client/src/utils/hermes/mcp-app-pip'

it('replaces an older PiP instance even when the tool call is the same', () => {
  const revokeFirst = vi.fn()
  const revokeSecond = vi.fn()
  const releaseFirst = claimMcpAppPip(revokeFirst)
  const releaseSecond = claimMcpAppPip(revokeSecond)

  expect(revokeFirst).toHaveBeenCalledOnce()
  releaseFirst()

  const releaseThird = claimMcpAppPip(vi.fn())
  expect(revokeSecond).toHaveBeenCalledOnce()
  releaseSecond()
  releaseThird()
})
