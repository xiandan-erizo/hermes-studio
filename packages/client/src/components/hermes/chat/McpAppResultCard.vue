<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { AppBridge, PostMessageTransport, type McpUiHostContext, type McpUiStyles } from '@modelcontextprotocol/ext-apps/app-bridge'
import { resolveMcpApp, type McpAppResolveResponse } from '@/api/hermes/mcp'
import { useTheme } from '@/composables/useTheme'
import { safeMcpAppExternalUrl, type McpAppInvocation } from '@/utils/hermes/mcp-app-result'
import { buildSandboxUrl, mcpAppStyleVariables } from '@/utils/hermes/mcp-app-sandbox'
import { createMcpAppTeardown } from '@/utils/hermes/mcp-app-lifecycle'

const props = defineProps<{ invocation: McpAppInvocation; profile?: string }>()
const { t, locale } = useI18n()
const { isDark } = useTheme()
const iframeRef = ref<HTMLIFrameElement | null>(null)
const dialogRef = ref<HTMLDialogElement | null>(null)
const expandRef = ref<HTMLButtonElement | null>(null)
const resolved = ref<McpAppResolveResponse | null>(null)
const frameUrl = ref<string>()
const frameHeight = ref(240)
const expanded = ref(false)
const canExpand = ref(false)
const phase = ref<'loading' | 'ready' | 'error' | 'unavailable'>('loading')
const frameKey = ref(0)
let bridge: AppBridge | null = null
let bridgeWindow: Window | null = null
let bridgeInitialized = false
let generation = 0
let initializationTimer: ReturnType<typeof setTimeout> | undefined
let resizeObserver: ResizeObserver | undefined
const teardownBridge = createMcpAppTeardown()

const appTitle = computed(() => resolved.value?.app?.name || resolved.value?.tool?.server || t('mcpApp.application'))
const prefersBorder = computed(() => (resolved.value?.resource?._meta.ui as { prefersBorder?: boolean } | undefined)?.prefersBorder !== false)
const heightStyle = computed(() => expanded.value ? {} : { height: frameHeight.value + 'px' })
const fallbackText = computed(() => props.invocation.toolResult.content
  .filter(item => item.type === 'text').map(item => item.text).join('\n'))

async function closeBridge(): Promise<void> {
  clearTimeout(initializationTimer)
  initializationTimer = undefined
  const previous = bridge
  const initialized = bridgeInitialized
  bridge = null
  bridgeWindow = null
  bridgeInitialized = false
  // Controlled replacement waits for cleanup. Vue/page unmount still sends
  // teardown before its synchronous DOM removal, then closes the transport.
  await teardownBridge(previous, initialized)
}

function fail(cycle: number, error: unknown): void {
  if (cycle !== generation) return
  phase.value = 'error'
  void closeBridge()
  console.warn('[MCP App] View initialization failed', error)
}

function hostContext(): McpUiHostContext {
  const width = Math.max(1, iframeRef.value?.clientWidth || 680)
  return {
    theme: isDark.value ? 'dark' : 'light',
    styles: { variables: mcpAppStyleVariables(isDark.value) as McpUiStyles },
    displayMode: expanded.value ? 'fullscreen' : 'inline',
    availableDisplayModes: ['inline', 'fullscreen'],
    containerDimensions: expanded.value
      ? { width, height: iframeRef.value?.clientHeight || window.innerHeight - 128 }
      : { width, maxHeight: Math.max(240, window.innerHeight - 160) },
    locale: locale.value,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    platform: 'web',
    deviceCapabilities: { touch: navigator.maxTouchPoints > 0, hover: window.matchMedia('(hover: hover)').matches },
  }
}

function updateHostContext(): void {
  if (bridgeInitialized) bridge?.setHostContext(hostContext())
}

async function setDisplayMode(mode: string): Promise<{ mode: 'inline' | 'fullscreen' }> {
  if ((mode !== 'inline' && mode !== 'fullscreen') || (mode === 'fullscreen' && !canExpand.value)) {
    return { mode: expanded.value ? 'fullscreen' : 'inline' }
  }
  const nextExpanded = mode === 'fullscreen'
  if (expanded.value !== nextExpanded) {
    // A native dialog's top-layer transition preserves its iframe document.
    dialogRef.value?.close()
    expanded.value = nextExpanded
    await nextTick()
    if (nextExpanded) dialogRef.value?.showModal()
    else dialogRef.value?.show()
    await nextTick()
    updateHostContext()
    expandRef.value?.focus({ preventScroll: true })
  }
  return { mode: expanded.value ? 'fullscreen' : 'inline' }
}

async function startBridge(response: McpAppResolveResponse, cycle: number): Promise<void> {
  const target = iframeRef.value?.contentWindow
  const { tool, resource } = JSON.parse(JSON.stringify(response)) as McpAppResolveResponse
  if (!target || !tool || !resource) throw new Error('App frame is unavailable')
  const sandboxUrl = buildSandboxUrl(window.location.origin, response.sandboxOrigin, resource._meta)
  const currentBridge = new AppBridge(null, { name: 'Hermes Studio', version: '0.7' }, { openLinks: {} }, {
    hostContext: {
      ...hostContext(),
      toolInfo: {
        ...(props.invocation.toolCallId ? { id: props.invocation.toolCallId } : {}),
        tool: {
          name: tool.raw_name, title: tool.title, description: tool.description,
          inputSchema: { ...tool.input_schema, type: 'object' as const },
          ...(tool.output_schema ? { outputSchema: { ...tool.output_schema, type: 'object' as const } } : {}),
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
          _meta: tool._meta,
        },
      },
    },
  })
  bridge = currentBridge
  bridgeWindow = target
  currentBridge.onopenlink = async ({ url }) => {
    if (cycle !== generation) return { isError: true }
    const safeUrl = safeMcpAppExternalUrl(url)
    if (!safeUrl) return { isError: true }
    window.open(safeUrl, '_blank', 'noopener,noreferrer')
    return {}
  }
  currentBridge.onrequestdisplaymode = ({ mode }) => cycle === generation
    ? setDisplayMode(mode)
    : Promise.resolve({ mode: 'inline' as const })
  currentBridge.addEventListener('sandboxready', () => {
    if (cycle !== generation) return
    void currentBridge.sendSandboxResourceReady({ html: resource.text }).catch(error => fail(cycle, error))
  })
  currentBridge.addEventListener('sizechange', ({ height }) => {
    if (cycle !== generation || expanded.value) return
    if (typeof height === 'number' && Number.isFinite(height)) {
      frameHeight.value = Math.min(Math.max(240, window.innerHeight - 160), Math.max(120, Math.ceil(height)))
    }
  })
  currentBridge.addEventListener('initialized', () => {
    void (async () => {
      if (cycle !== generation) return
      bridgeInitialized = true
      canExpand.value = currentBridge.getAppCapabilities()?.availableDisplayModes?.includes('fullscreen') ?? false
      await currentBridge.sendToolInput({ arguments: props.invocation.toolArgs })
      await currentBridge.sendToolResult(props.invocation.toolResult)
      if (cycle !== generation) return
      clearTimeout(initializationTimer)
      phase.value = 'ready'
    })().catch(error => fail(cycle, error))
  })
  initializationTimer = setTimeout(() => fail(cycle, new Error('App initialization timed out')), 12_000)
  await currentBridge.connect(new PostMessageTransport(target, target))
  if (cycle === generation) frameUrl.value = sandboxUrl
}

async function mountView(response: McpAppResolveResponse): Promise<void> {
  const cycle = ++generation
  await closeBridge()
  if (cycle !== generation) return
  await setDisplayMode('inline')
  phase.value = 'loading'
  frameUrl.value = undefined
  frameKey.value += 1
  frameHeight.value = 240
  canExpand.value = false
  try {
    await nextTick()
    if (cycle === generation) await startBridge(response, cycle)
  } catch (error) { fail(cycle, error) }
}

function onFrameLoad(): void {
  if (resolved.value && bridgeWindow && iframeRef.value?.contentWindow !== bridgeWindow) {
    void mountView(resolved.value)
  }
}

async function load(): Promise<void> {
  const cycle = ++generation
  await closeBridge()
  if (cycle !== generation) return
  phase.value = 'loading'
  resolved.value = null
  try {
    const response = await resolveMcpApp(props.invocation.toolName, props.profile)
    if (cycle !== generation) return
    if (response.code === 'mcp_app_not_found') { phase.value = 'unavailable'; return }
    if (!response.ok || !response.tool || !response.resource) throw new Error(response.error || 'App resource is unavailable')
    resolved.value = response
    await mountView(response)
  } catch (error) {
    if (cycle !== generation) return
    if ((error as { code?: string })?.code === 'mcp_app_not_found') phase.value = 'unavailable'
    else fail(cycle, error)
  }
}

watch([isDark, locale], async () => { await nextTick(); updateHostContext() })
watch(() => props.profile, () => { void load() })
watch(() => JSON.stringify(props.invocation), (value, previous) => {
  const next = JSON.parse(value) as McpAppInvocation
  const before = JSON.parse(previous) as McpAppInvocation
  if (next.toolName !== before.toolName || next.toolCallId !== before.toolCallId) { void load(); return }
  if (bridgeInitialized && bridge) {
    const current = bridge
    const cycle = generation
    void current.sendToolInput({ arguments: props.invocation.toolArgs })
      .then(() => current.sendToolResult(props.invocation.toolResult)).catch(error => fail(cycle, error))
  }
})
onMounted(() => {
  resizeObserver = new ResizeObserver(updateHostContext)
  if (dialogRef.value) resizeObserver.observe(dialogRef.value)
  window.addEventListener('resize', updateHostContext)
  void load()
})
watch(dialogRef, value => { if (value) resizeObserver?.observe(value) })
onBeforeUnmount(() => {
  generation += 1
  resizeObserver?.disconnect()
  window.removeEventListener('resize', updateHostContext)
  void closeBridge()
})
</script>

<template>
  <div v-if="resolved?.resource || phase === 'error'" class="mcp-app-anchor" :style="expanded ? { minHeight: (frameHeight + 48) + 'px' } : {}">
    <dialog ref="dialogRef" open class="mcp-app-result" :class="{ 'is-expanded': expanded }"
      :role="expanded ? 'dialog' : 'region'" :aria-label="appTitle"
      @cancel.prevent="setDisplayMode('inline')">
      <div class="result-toolbar">
        <div class="mcp-app-identity">
          <span class="mcp-app-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24"><rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="4" width="6" height="6" rx="1.5"/><rect x="4" y="14" width="6" height="6" rx="1.5"/><rect x="14" y="14" width="6" height="6" rx="1.5"/></svg>
          </span>
          <span class="mcp-app-title">{{ appTitle }}</span>
          <span v-if="phase === 'loading'" class="loading-label" role="status">{{ t('common.loading') }}</span>
        </div>
        <button v-if="canExpand && phase === 'ready'" ref="expandRef" type="button" class="expand-control"
          :aria-label="expanded ? t('common.collapse') : t('common.expand')"
          :title="expanded ? t('common.collapse') : t('common.expand')" :aria-expanded="expanded"
          @click="setDisplayMode(expanded ? 'inline' : 'fullscreen')">
          <svg v-if="expanded" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
          <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7"/></svg>
        </button>
      </div>
      <div v-if="phase === 'error'" class="result-error">
        <p role="alert">{{ t('mcpApp.loadFailed') }}</p>
        <button type="button" class="retry-control" @click="load">{{ t('common.retry') }}</button>
        <pre v-if="fallbackText" class="result-fallback">{{ fallbackText }}</pre>
      </div>
      <div v-else class="mcp-app-frame-shell" :class="{ 'without-border': !prefersBorder }" :aria-busy="phase === 'loading'">
        <div v-if="phase === 'loading'" class="app-skeleton" aria-hidden="true"><span/><span/><span/></div>
        <iframe :key="frameKey" ref="iframeRef" class="mcp-app-frame" sandbox="allow-scripts allow-same-origin"
          referrerpolicy="no-referrer" :src="frameUrl" :title="appTitle" :style="heightStyle" @load="onFrameLoad" />
      </div>
    </dialog>
  </div>
</template>

<style scoped lang="scss">
.mcp-app-anchor { width: 100%; max-width: 760px; min-width: 0; margin-block: 8px 18px; }
.mcp-app-result {
  position: relative; display: block; inset: auto; width: 100%; max-width: none; max-height: none;
  min-width: 0; box-sizing: border-box; margin: 0; padding: 0; border: 0;
  background: transparent; color: var(--text-primary); font: inherit;
  &.is-expanded {
    position: fixed; inset: 24px; width: min(960px, calc(100vw - 48px)); height: calc(100dvh - 48px);
    margin: auto; padding: 12px 20px 20px; border-radius: 20px; background: var(--bg-primary, #fff);
    box-shadow: 0 24px 100px #0003; display: flex; flex-direction: column;
    .result-toolbar { flex-shrink: 0; margin-bottom: 8px; }
    .mcp-app-frame-shell { flex: 1; min-height: 0; border-color: transparent; }
    .mcp-app-frame { height: 100%; }
  }
  &::backdrop { background: #0006; backdrop-filter: blur(4px); }
}
.result-toolbar { display: flex; align-items: center; justify-content: space-between; min-height: 40px; padding-block: 0 8px; }
.mcp-app-identity { display: flex; align-items: center; min-width: 0; gap: 9px; }
.mcp-app-icon {
  display: grid; place-items: center; width: 25px; height: 25px; flex-shrink: 0;
  border: 1px solid var(--border-color); border-radius: 8px; background: var(--bg-main, var(--bg-secondary));
  svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.5; }
}
.mcp-app-title { overflow: hidden; font-size: 13px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.loading-label { color: var(--text-secondary); font-size: 12px; }
.mcp-app-frame-shell { position: relative; overflow: hidden; border: 1px solid var(--border-color); border-radius: 16px; background: var(--bg-main, var(--bg-secondary)); }
.mcp-app-frame-shell.without-border { border-color: transparent; background: transparent; }
.mcp-app-frame { display: block; width: 100%; min-height: 120px; border: 0; }
.expand-control {
  display: grid; place-items: center; width: 28px; height: 28px; border: 0; border-radius: 7px;
  padding: 5px; background: transparent; color: var(--text-secondary); cursor: pointer;
  &:hover { background: var(--bg-secondary); color: var(--text-primary); }
  &:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; }
  svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
}
.result-error { padding: 20px; border: 1px solid var(--border-color); border-radius: 16px; color: var(--text-secondary); p { margin: 0 0 12px; } }
.retry-control { padding: 6px 12px; border: 1px solid var(--border-color); border-radius: 8px; background: var(--bg-secondary); color: var(--text-primary); font: inherit; cursor: pointer; }
.result-fallback { max-height: 320px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
.app-skeleton {
  position: absolute; inset: 0; z-index: 1; padding: 24px; background: var(--bg-main, var(--bg-secondary));
  span { display: block; height: 12px; margin-bottom: 16px; border-radius: 5px; background: var(--bg-secondary); }
  span:first-child { width: 58%; height: 20px; margin-bottom: 26px; }
  span:last-child { width: 72%; }
}
@media (max-width: 600px) {
  .mcp-app-anchor { margin-block: 4px 14px; }
  .mcp-app-result.is-expanded { inset: 8px; width: calc(100vw - 16px); height: calc(100dvh - 16px); padding: 8px 10px 10px; border-radius: 16px; }
}
</style>
