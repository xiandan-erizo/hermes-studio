<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge'
import { resolveMcpApp, type McpAppResolveResponse } from '@/api/hermes/mcp'
import { useTheme } from '@/composables/useTheme'
import {
  buildMcpAppSrcdoc,
  safeMcpAppExternalUrl,
  type McpAppInvocation,
} from '@/utils/hermes/mcp-app-result'

const props = defineProps<{ invocation: McpAppInvocation }>()
const { t } = useI18n()
const { isDark } = useTheme()
const iframeRef = ref<HTMLIFrameElement | null>(null)
const resolved = ref<McpAppResolveResponse | null>(null)
// Start with the iframe's initial about:blank document. A placeholder srcdoc
// races the real srcdoc navigation in Chrome's isolated frame renderer.
const srcdoc = ref<string>()
const frameHeight = ref(320)
const expanded = ref(false)
const phase = ref<'loading' | 'ready' | 'error' | 'unavailable'>('loading')
const frameKey = ref(0)
let bridge: AppBridge | null = null
let bridgeWindow: Window | null = null
let generation = 0
let initializationTimer: ReturnType<typeof setTimeout> | undefined

const title = computed(() => resolved.value?.tool?.raw_name || resolved.value?.resource?.uri || '')
const heightStyle = computed(() => ({
  height: expanded.value ? 'min(70dvh, 720px)' : `${frameHeight.value}px`,
}))
const fallbackText = computed(() => props.invocation.toolResult.content
  .filter(item => item.type === 'text')
  .map(item => item.text)
  .join('\n'))

function closeBridge(): void {
  clearTimeout(initializationTimer)
  initializationTimer = undefined
  const previous = bridge
  bridge = null
  bridgeWindow = null
  if (previous) void previous.close().catch(() => {})
}

function fail(cycle: number, error: unknown): void {
  if (cycle !== generation) return
  phase.value = 'error'
  closeBridge()
  console.warn('[MCP App] View initialization failed', error)
}

function locale(): string {
  return navigator.language || 'en'
}

function timeZone(): string | undefined {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return undefined }
}

async function startBridge(response: McpAppResolveResponse, cycle: number): Promise<void> {
  const iframe = iframeRef.value
  const target = iframe?.contentWindow
  // Reconnection reads from a Vue ref; descriptor fields must be plain JSON
  // before the SDK includes them in the iframe's postMessage handshake.
  const { tool, resource } = JSON.parse(JSON.stringify(response)) as McpAppResolveResponse
  if (!iframe || !target || !tool || !resource) throw new Error('App frame is unavailable')

  const currentBridge = new AppBridge(
    null,
    { name: 'Hermes Studio', version: '0.7' },
    { openLinks: {} },
    {
      hostContext: {
        toolInfo: {
          ...(props.invocation.toolCallId ? { id: props.invocation.toolCallId } : {}),
          tool: {
            name: tool.raw_name,
            description: tool.description,
            inputSchema: { ...tool.input_schema, type: 'object' as const },
            ...(tool.output_schema
              ? { outputSchema: { ...tool.output_schema, type: 'object' as const } }
              : {}),
            ...(tool.annotations ? { annotations: tool.annotations } : {}),
            _meta: tool._meta,
          },
        },
        theme: isDark.value ? 'dark' : 'light',
        displayMode: 'inline',
        availableDisplayModes: ['inline'],
        containerDimensions: { maxWidth: 960, maxHeight: 720 },
        locale: locale(),
        ...(timeZone() ? { timeZone: timeZone() } : {}),
        userAgent: 'Hermes Studio',
        platform: 'web',
        deviceCapabilities: {
          touch: navigator.maxTouchPoints > 0,
          hover: window.matchMedia?.('(hover: hover)').matches ?? false,
        },
      },
    },
  )
  bridge = currentBridge
  bridgeWindow = target
  currentBridge.onopenlink = async ({ url }) => {
    const safeUrl = safeMcpAppExternalUrl(url)
    if (!safeUrl) return { isError: true }
    window.open(safeUrl, '_blank', 'noopener,noreferrer')
    return {}
  }
  currentBridge.addEventListener('sizechange', ({ height }) => {
    if (cycle !== generation) return
    if (typeof height === 'number' && Number.isFinite(height)) {
      frameHeight.value = Math.min(720, Math.max(160, Math.ceil(height)))
    }
  })
  currentBridge.addEventListener('initialized', () => {
    void (async () => {
      if (cycle !== generation) return
      await currentBridge.sendToolInput({ arguments: props.invocation.toolArgs })
      await currentBridge.sendToolResult(props.invocation.toolResult)
      if (cycle !== generation) return
      clearTimeout(initializationTimer)
      phase.value = 'ready'
    })().catch(error => fail(cycle, error))
  })
  initializationTimer = setTimeout(() => fail(cycle, new Error('App initialization timed out')), 12_000)
  await currentBridge.connect(new PostMessageTransport(target, target))
  if (cycle !== generation) return
  srcdoc.value = buildMcpAppSrcdoc(resource.text, resource._meta)
}

async function mountView(response: McpAppResolveResponse): Promise<void> {
  const cycle = ++generation
  closeBridge()
  phase.value = 'loading'
  srcdoc.value = undefined
  frameKey.value += 1
  frameHeight.value = 320
  expanded.value = false
  try {
    await nextTick()
    if (cycle === generation) await startBridge(response, cycle)
  } catch (error) {
    fail(cycle, error)
  }
}

function onFrameLoad(): void {
  // Moving a keyed chat row recreates its iframe browsing context without
  // remounting this Vue component. The old transport still trusts the old Window.
  if (resolved.value && bridgeWindow && iframeRef.value?.contentWindow !== bridgeWindow) {
    void mountView(resolved.value)
  }
}

async function load(): Promise<void> {
  const cycle = ++generation
  closeBridge()
  phase.value = 'loading'
  resolved.value = null
  try {
    const response = await resolveMcpApp(props.invocation.toolName)
    if (cycle !== generation) return
    if (response.code === 'mcp_app_not_found') {
      phase.value = 'unavailable'
      return
    }
    if (!response.ok || !response.tool || !response.resource) throw new Error(response.error || 'App resource is unavailable')
    resolved.value = response
    await mountView(response)
  } catch (error) {
    if (cycle !== generation) return
    if ((error as { code?: string })?.code === 'mcp_app_not_found') phase.value = 'unavailable'
    else fail(cycle, error)
  }
}

watch(isDark, value => {
  bridge?.setHostContext({ theme: value ? 'dark' : 'light' })
})

onMounted(() => { void load() })
onBeforeUnmount(() => {
  generation += 1
  closeBridge()
})
</script>

<template>
  <section v-if="resolved?.resource || phase === 'error'" class="mcp-app-result" :aria-label="title">
    <div v-if="phase !== 'error'" class="result-toolbar">
      <span v-if="phase === 'loading'" class="loading-label" role="status">{{ t('common.loading') }}</span>
      <button
        type="button"
        class="expand-control"
        :aria-label="expanded ? t('common.collapse') : t('common.expand')"
        :title="expanded ? t('common.collapse') : t('common.expand')"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        <svg v-if="expanded" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9 3v6H3M15 21v-6h6M3 9l6-6M21 15l-6 6" />
        </svg>
        <svg v-else viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8 3H3v5M16 21h5v-5M3 8l6-6M21 16l-6 6" />
        </svg>
      </button>
    </div>
    <div v-if="phase === 'error'" class="result-error">
      <p role="alert">{{ t('mcpApp.loadFailed') }}</p>
      <button type="button" class="retry-control" @click="load">{{ t('common.retry') }}</button>
      <pre v-if="fallbackText" class="result-fallback">{{ fallbackText }}</pre>
    </div>
    <iframe
      v-else
      :key="frameKey"
      ref="iframeRef"
      class="mcp-app-frame"
      sandbox="allow-scripts"
      referrerpolicy="no-referrer"
      :srcdoc="srcdoc"
      :title="title"
      :style="heightStyle"
      @load="onFrameLoad"
    />
  </section>
</template>

<style scoped lang="scss">
.mcp-app-result {
  width: 100%;
  max-width: 960px;
  min-width: 0;
  box-sizing: border-box;
}

.result-toolbar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  height: 30px;
  padding: 0 2px 4px;
}

.loading-label {
  margin-right: auto;
  color: var(--text-secondary);
  font-size: 13px;
}

.result-error {
  padding: 16px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--text-secondary);

  p { margin: 0 0 10px; }
}

.retry-control {
  padding: 6px 12px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font: inherit;
  cursor: pointer;
}

.result-fallback {
  max-height: 320px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
}

.expand-control {
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;

  &:hover {
    background: var(--bg-secondary);
    color: var(--text-primary);
  }

  &:focus-visible {
    outline: 2px solid var(--accent-primary);
    outline-offset: 2px;
  }

  svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
}

.mcp-app-frame {
  display: block;
  width: 100%;
  min-height: 160px;
  max-height: 720px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  transition: height 160ms ease;
}
</style>
