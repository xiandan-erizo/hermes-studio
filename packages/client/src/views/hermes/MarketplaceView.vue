<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  NAlert,
  NButton,
  NDrawer,
  NDrawerContent,
  NEmpty,
  NInput,
  NModal,
  NSelect,
  NSpin,
  NTag,
  useDialog,
  useMessage,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import MarkdownRenderer from '@/components/hermes/chat/MarkdownRenderer.vue'
import { isStoredElevatedUser } from '@/api/client'
import {
  createMarketplaceSource,
  deleteMarketplaceSource,
  fetchMarketplaceInstalled,
  fetchMarketplacePluginDetail,
  fetchMarketplacePlugins,
  fetchMarketplaceSources,
  installMarketplaceSkill,
  refreshMarketplaceSource,
  uninstallMarketplaceSkill,
  type MarketplaceInstalledSkill,
  type MarketplacePlugin,
  type MarketplacePluginDetail,
  type MarketplaceSource,
} from '@/api/hermes/marketplace'

const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()

const isElevated = isStoredElevatedUser()

const sources = ref<MarketplaceSource[]>([])
const selectedSourceId = ref<number | null>(null)
const plugins = ref<MarketplacePlugin[]>([])
const installed = ref<MarketplaceInstalledSkill[]>([])
const loadingSources = ref(false)
const loadingPlugins = ref(false)
const loadError = ref('')

const searchQuery = ref('')
const showAddSource = ref(false)
const newSourceName = ref('')
const newSourceUrl = ref('')
const creatingSource = ref(false)

const refreshing = ref(false)

const selectedSource = computed(() => sources.value.find(s => s.id === selectedSourceId.value) || null)

const installedBySkill = computed(() => {
  const map = new Map<string, MarketplaceInstalledSkill>()
  for (const entry of installed.value) map.set(entry.skill, entry)
  return map
})

const sourceOptions = computed(() => sources.value.map(source => ({
  label: source.name,
  value: source.id,
})))

const filteredPlugins = computed(() => {
  const query = searchQuery.value.trim().toLowerCase()
  if (!query) return plugins.value
  return plugins.value.filter((plugin) => {
    const iface = plugin.interface
    return [
      plugin.name,
      plugin.description,
      iface?.displayName,
      iface?.shortDescription,
      iface?.category,
      ...plugin.skills.map(skill => `${skill.name} ${skill.description}`),
    ].some(value => String(value || '').toLowerCase().includes(query))
  })
})

const detailVisible = ref(false)
const detailPlugin = ref<MarketplacePluginDetail | null>(null)
const detailLoading = ref(false)
const detailError = ref('')
const installingSkill = ref('')
const uninstallingSkill = ref('')

function formatTime(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return ''
  const date = typeof value === 'number' ? new Date(value) : new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString()
}

async function loadSources(): Promise<void> {
  loadingSources.value = true
  try {
    sources.value = await fetchMarketplaceSources()
    if (!selectedSourceId.value && sources.value.length > 0) {
      selectedSourceId.value = sources.value[0].id
    }
    if (selectedSourceId.value && !sources.value.some(s => s.id === selectedSourceId.value)) {
      selectedSourceId.value = sources.value[0]?.id ?? null
    }
  } catch (err: any) {
    message.error(t('marketplace.loadFailed', { error: err?.message || err }))
  } finally {
    loadingSources.value = false
  }
}

async function loadInstalled(): Promise<void> {
  try {
    installed.value = await fetchMarketplaceInstalled()
  } catch { /* installed list is best-effort for badges */ }
}

async function loadPlugins(): Promise<void> {
  if (!selectedSourceId.value) {
    plugins.value = []
    return
  }
  loadingPlugins.value = true
  loadError.value = ''
  try {
    plugins.value = await fetchMarketplacePlugins(selectedSourceId.value)
  } catch (err: any) {
    loadError.value = String(err?.message || err)
    plugins.value = []
  } finally {
    loadingPlugins.value = false
  }
}

async function handleRefresh(): Promise<void> {
  if (!selectedSourceId.value) return
  refreshing.value = true
  try {
    await refreshMarketplaceSource(selectedSourceId.value)
    await Promise.all([loadSources(), loadPlugins()])
    message.success(t('marketplace.refreshed'))
  } catch (err: any) {
    message.error(String(err?.message || err))
  } finally {
    refreshing.value = false
  }
}

async function handleCreateSource(): Promise<void> {
  const name = newSourceName.value.trim()
  const url = newSourceUrl.value.trim()
  if (!name || !url) return
  creatingSource.value = true
  try {
    const { syncError } = await createMarketplaceSource(name, url)
    showAddSource.value = false
    newSourceName.value = ''
    newSourceUrl.value = ''
    await loadSources()
    const created = sources.value.find(s => s.url === url)
    if (created) selectedSourceId.value = created.id
    if (syncError) {
      message.warning(t('marketplace.createdSyncFailed', { error: syncError }))
    } else {
      message.success(t('marketplace.created'))
    }
  } catch (err: any) {
    message.error(String(err?.message || err))
  } finally {
    creatingSource.value = false
  }
}

function confirmDeleteSource(): void {
  if (!selectedSource.value) return
  dialog.warning({
    title: t('marketplace.deleteSourceTitle'),
    content: t('marketplace.deleteSourceConfirm', { name: selectedSource.value.name }),
    positiveText: t('common.confirm'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      try {
        await deleteMarketplaceSource(selectedSource.value!.id)
        selectedSourceId.value = null
        await loadSources()
        await loadPlugins()
        message.success(t('marketplace.sourceDeleted'))
      } catch (err: any) {
        message.error(String(err?.message || err))
      }
    },
  })
}

async function openDetail(plugin: MarketplacePlugin): Promise<void> {
  if (!selectedSourceId.value) return
  detailVisible.value = true
  detailPlugin.value = null
  detailError.value = ''
  detailLoading.value = true
  try {
    detailPlugin.value = await fetchMarketplacePluginDetail(selectedSourceId.value, plugin.name)
    if (!detailPlugin.value) detailError.value = t('marketplace.pluginMissing')
  } catch (err: any) {
    detailError.value = String(err?.message || err)
  } finally {
    detailLoading.value = false
  }
}

async function handleInstall(pluginName: string, skillName: string): Promise<void> {
  if (!selectedSourceId.value) return
  installingSkill.value = skillName
  try {
    await installMarketplaceSkill(selectedSourceId.value, pluginName, skillName)
    await loadInstalled()
    message.success(t('marketplace.installSuccess', { name: skillName }))
  } catch (err: any) {
    message.error(String(err?.message || err))
  } finally {
    installingSkill.value = ''
  }
}

function confirmUninstall(skillName: string): void {
  dialog.warning({
    title: t('marketplace.uninstall'),
    content: t('marketplace.uninstallConfirm', { name: skillName }),
    positiveText: t('common.confirm'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      uninstallingSkill.value = skillName
      try {
        await uninstallMarketplaceSkill(skillName)
        await loadInstalled()
        message.success(t('marketplace.uninstallSuccess', { name: skillName }))
      } catch (err: any) {
        message.error(String(err?.message || err))
      } finally {
        uninstallingSkill.value = ''
      }
    },
  })
}

watch(selectedSourceId, () => { loadPlugins() })

onMounted(async () => {
  await Promise.all([loadSources(), loadInstalled()])
  await loadPlugins()
})
</script>

<template>
  <div class="marketplace-page">
    <div class="page-header">
      <h1 class="page-title">{{ t('marketplace.title') }}</h1>
      <p class="page-subtitle">{{ t('marketplace.subtitle') }}</p>
    </div>

    <div class="toolbar">
      <NSelect
        v-model:value="selectedSourceId"
        :options="sourceOptions"
        :placeholder="t('marketplace.sourcePlaceholder')"
        class="source-select"
        size="small"
      />
      <NInput
        v-model:value="searchQuery"
        :placeholder="t('marketplace.search')"
        clearable
        size="small"
        class="search-input"
      />
      <NButton
        v-if="isElevated"
        size="small"
        :loading="refreshing"
        :disabled="!selectedSourceId"
        @click="handleRefresh"
      >
        {{ t('marketplace.refresh') }}
      </NButton>
      <NButton
        v-if="isElevated"
        size="small"
        type="primary"
        ghost
        @click="showAddSource = true"
      >
        {{ t('marketplace.addSource') }}
      </NButton>
      <NButton
        v-if="isElevated && selectedSource"
        size="small"
        quaternary
        type="error"
        @click="confirmDeleteSource"
      >
        {{ t('marketplace.deleteSource') }}
      </NButton>
    </div>

    <NAlert
      v-if="selectedSource?.lastError"
      type="warning"
      class="source-status"
      :show-icon="true"
    >
      {{ t('marketplace.syncFailed') }}: {{ selectedSource.lastError }}
    </NAlert>
    <div v-else-if="selectedSource?.lastSyncedAt" class="source-status text-muted">
      {{ t('marketplace.lastSynced') }}: {{ formatTime(selectedSource.lastSyncedAt) }}
      <span v-if="selectedSource.lastCommit" class="commit">
        @{{ selectedSource.lastCommit.slice(0, 8) }}
      </span>
    </div>

    <NSpin :show="loadingSources || loadingPlugins">
      <div class="plugin-grid">
        <NEmpty
          v-if="!selectedSourceId && sources.length === 0"
          :description="isElevated ? t('marketplace.emptyAdmin') : t('marketplace.empty')"
          class="empty-state"
        />
        <NEmpty
          v-else-if="selectedSourceId && !loadingPlugins && filteredPlugins.length === 0"
          :description="t('marketplace.noPlugins')"
          class="empty-state"
        />
        <div
          v-for="plugin in filteredPlugins"
          :key="plugin.name"
          class="plugin-card"
          @click="openDetail(plugin)"
        >
          <div class="plugin-card-head">
            <span class="plugin-title">{{ plugin.interface?.displayName || plugin.name }}</span>
            <NTag v-if="plugin.version" size="tiny" type="info">{{ plugin.version }}</NTag>
            <NTag v-if="plugin.skills.some(s => installedBySkill.has(s.name))" size="tiny" type="success">
              {{ t('marketplace.installed') }}
            </NTag>
          </div>
          <div class="plugin-name">{{ plugin.name }}</div>
          <p class="plugin-desc">
            {{ plugin.interface?.shortDescription || plugin.description }}
          </p>
          <div class="plugin-meta">
            <NTag v-if="plugin.interface?.category" size="tiny" :bordered="false">
              {{ plugin.interface.category }}
            </NTag>
            <span class="text-muted">
              {{ t('marketplace.skillCount', { n: plugin.skills.length }) }}
            </span>
          </div>
        </div>
      </div>
    </NSpin>

    <NDrawer v-model:show="detailVisible" :width="640" placement="right">
      <NDrawerContent :title="detailPlugin?.interface?.displayName || detailPlugin?.name || ''" closable>
        <NSpin :show="detailLoading">
          <NAlert v-if="detailError" type="error">{{ detailError }}</NAlert>
          <div v-else-if="detailPlugin" class="plugin-detail">
            <div class="detail-meta">
              <NTag v-if="detailPlugin.version" size="small" type="info">{{ detailPlugin.version }}</NTag>
              <NTag v-if="detailPlugin.interface?.category" size="small" :bordered="false">
                {{ detailPlugin.interface.category }}
              </NTag>
              <span class="text-muted detail-name">{{ detailPlugin.name }}</span>
            </div>
            <p class="detail-desc">
              {{ detailPlugin.interface?.longDescription || detailPlugin.description }}
            </p>
            <div v-if="detailPlugin.interface?.defaultPrompt?.length" class="detail-prompt">
              <div class="section-label">{{ t('marketplace.defaultPrompt') }}</div>
              <ul>
                <li v-for="(prompt, idx) in detailPlugin.interface.defaultPrompt" :key="idx">{{ prompt }}</li>
              </ul>
            </div>

            <div
              v-for="skill in detailPlugin.skills"
              :key="skill.name"
              class="skill-block"
            >
              <div class="skill-block-head">
                <div class="skill-block-title">
                  <span class="skill-name">{{ skill.name }}</span>
                  <span v-if="installedBySkill.has(skill.name)" class="text-muted">
                    {{ t('marketplace.installedAt', { time: formatTime(installedBySkill.get(skill.name)!.updatedAt) }) }}
                  </span>
                </div>
                <div class="skill-actions">
                  <template v-if="installedBySkill.has(skill.name)">
                    <NTag v-if="installedBySkill.get(skill.name)!.modified" size="tiny" type="warning">
                      {{ t('marketplace.modified') }}
                    </NTag>
                    <NButton
                      size="tiny"
                      quaternary
                      type="error"
                      :loading="uninstallingSkill === skill.name"
                      @click="confirmUninstall(skill.name)"
                    >
                      {{ t('marketplace.uninstall') }}
                    </NButton>
                  </template>
                  <NButton
                    v-else
                    size="tiny"
                    type="primary"
                    ghost
                    :loading="installingSkill === skill.name"
                    @click="handleInstall(detailPlugin.name, skill.name)"
                  >
                    {{ t('marketplace.install') }}
                  </NButton>
                </div>
              </div>
              <p class="skill-desc">{{ skill.description }}</p>
              <div class="skill-md">
                <MarkdownRenderer :content="skill.content" />
              </div>
            </div>
          </div>
        </NSpin>
      </NDrawerContent>
    </NDrawer>

    <NModal
      v-model:show="showAddSource"
      preset="dialog"
      :title="t('marketplace.addSource')"
      :positive-text="t('common.confirm')"
      :negative-text="t('common.cancel')"
      :loading="creatingSource"
      :on-positive-click="() => { void handleCreateSource(); return false }"
    >
      <div class="add-source-form">
        <label class="form-label">{{ t('marketplace.sourceName') }}</label>
        <NInput v-model:value="newSourceName" :placeholder="t('marketplace.sourceNamePlaceholder')" />
        <label class="form-label">{{ t('marketplace.sourceUrl') }}</label>
        <NInput v-model:value="newSourceUrl" placeholder="git@git.ekuaibao.com:ai-learning/hose-skills.git" />
        <p class="form-hint">{{ t('marketplace.sshOnlyHint') }}</p>
      </div>
    </NModal>
  </div>
</template>

<style scoped>
.marketplace-page {
  padding: 20px;
  max-width: 1200px;
  margin: 0 auto;
}

.page-header {
  margin-bottom: 16px;
}

.page-title {
  font-size: 22px;
  font-weight: 600;
  margin: 0 0 4px;
}

.page-subtitle {
  margin: 0;
  color: var(--n-text-color-3, #888);
  font-size: 13px;
}

.toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.source-select {
  width: 220px;
}

.search-input {
  flex: 1;
  min-width: 200px;
  max-width: 360px;
}

.source-status {
  margin-bottom: 12px;
  font-size: 13px;
}

.text-muted {
  color: var(--n-text-color-3, #888);
  font-size: 12px;
}

.commit {
  margin-inline-start: 6px;
  font-family: monospace;
}

.plugin-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px;
  min-height: 120px;
}

.empty-state {
  grid-column: 1 / -1;
  padding: 48px 0;
}

.plugin-card {
  border: 1px solid var(--n-border-color, #e0e0e6);
  border-radius: 8px;
  padding: 14px;
  cursor: pointer;
  transition: border-color 0.2s, box-shadow 0.2s;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.plugin-card:hover {
  border-color: var(--n-primary-color, #36ad6a);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
}

.plugin-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.plugin-title {
  font-weight: 600;
  font-size: 15px;
}

.plugin-name {
  font-size: 12px;
  color: var(--n-text-color-3, #888);
  font-family: monospace;
}

.plugin-desc {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.plugin-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: auto;
}

.plugin-detail {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.detail-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.detail-name {
  font-family: monospace;
}

.detail-desc {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
}

.detail-prompt {
  background: var(--n-color-embedded, #f7f7fa);
  border-radius: 6px;
  padding: 10px 14px;
  font-size: 13px;
}

.detail-prompt ul {
  margin: 6px 0 0;
  padding-inline-start: 18px;
}

.section-label {
  font-weight: 600;
  font-size: 12px;
}

.skill-block {
  border-top: 1px solid var(--n-border-color, #e0e0e6);
  padding-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.skill-block-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.skill-block-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.skill-name {
  font-weight: 600;
  font-size: 14px;
  font-family: monospace;
}

.skill-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.skill-desc {
  margin: 0;
  font-size: 13px;
}

.skill-md {
  border: 1px solid var(--n-border-color, #e0e0e6);
  border-radius: 6px;
  padding: 12px 16px;
  font-size: 13px;
  max-height: 480px;
  overflow-y: auto;
}

.add-source-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 4px 0;
}

.form-label {
  font-size: 13px;
  margin-top: 6px;
}

.form-hint {
  font-size: 12px;
  color: var(--n-text-color-3, #888);
  margin: 4px 0 0;
}
</style>
