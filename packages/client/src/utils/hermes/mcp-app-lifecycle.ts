import type { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge'

type ResourceBridge = Pick<AppBridge, 'teardownResource' | 'close'>

/** Every reload waits for outstanding cleanup, even after the active ref is cleared. */
export function createMcpAppTeardown(): (bridge: ResourceBridge | null, initialized: boolean) => Promise<void> {
  let pending = Promise.resolve()
  return (bridge, initialized) => {
    if (!bridge) return pending
    // Start synchronously so page/framework unmount sends teardown before DOM removal.
    const cleanup = (async () => {
      if (initialized) await bridge.teardownResource({}, { timeout: 800 }).catch(() => {})
      await bridge.close().catch(() => {})
    })()
    pending = Promise.all([pending, cleanup]).then(() => {})
    return pending
  }
}
