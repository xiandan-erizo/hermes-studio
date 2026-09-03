<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NButton, NEmpty, NPopconfirm, NSelect, NSpin, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  createExternalIdentity,
  deleteExternalIdentity,
  fetchExternalIdentities,
  fetchExternalIdentityCandidates,
  fetchExternalIdentityUsers,
  type ExternalIdentityCandidate,
  type ExternalIdentityMapping,
  type ExternalIdentityUser,
} from '@/api/studio/external-identities'

const { t } = useI18n()
const message = useMessage()

const mappings = ref<ExternalIdentityMapping[]>([])
const candidates = ref<ExternalIdentityCandidate[]>([])
const users = ref<ExternalIdentityUser[]>([])
const loadingMappings = ref(false)
const loadingCandidates = ref(false)
const bindChoices = ref<Record<string, number | null>>({})
const bindingKey = ref('')

const userOptions = computed(() => users.value.map(user => ({ label: user.username, value: user.id })))

function sourceTagType(source: string): 'success' | 'info' | 'warning' | 'default' {
  if (source === 'feishu') return 'success'
  if (source === 'dingtalk') return 'info'
  if (source === 'weixin' || source === 'wecom') return 'warning'
  return 'default'
}

function formatTime(ms: number): string {
  if (!ms) return '-'
  return new Date(ms).toLocaleString()
}

function truncateId(value: string): string {
  return value.length > 26 ? `${value.slice(0, 24)}…` : value
}

async function loadMappings() {
  loadingMappings.value = true
  try {
    const res = await fetchExternalIdentities()
    mappings.value = res.mappings
  } catch (err: any) {
    message.error(err?.message || t('externalIdentities.loadFailed'))
  } finally {
    loadingMappings.value = false
  }
}

async function loadCandidates() {
  loadingCandidates.value = true
  try {
    const res = await fetchExternalIdentityCandidates()
    candidates.value = res.candidates
  } catch (err: any) {
    message.error(err?.message || t('externalIdentities.loadFailed'))
  } finally {
    loadingCandidates.value = false
  }
}

async function loadUsers() {
  try {
    const res = await fetchExternalIdentityUsers()
    users.value = res.users
  } catch {
    // picker stays empty; mappings can still be managed via API
  }
}

async function bindCandidate(candidate: ExternalIdentityCandidate) {
  const key = `${candidate.source}:${candidate.external_id}`
  const userId = bindChoices.value[key]
  if (!userId) {
    message.warning(t('externalIdentities.userPlaceholder'))
    return
  }
  bindingKey.value = key
  try {
    await createExternalIdentity({
      source: candidate.source,
      external_id: candidate.external_id,
      user_id: userId,
    })
    message.success(t('externalIdentities.bindSuccess'))
    bindChoices.value[key] = null
    await Promise.all([loadMappings(), loadCandidates()])
  } catch (err: any) {
    message.error(err?.message || t('externalIdentities.bindFailed'))
  } finally {
    bindingKey.value = ''
  }
}

async function removeMapping(mapping: ExternalIdentityMapping) {
  try {
    await deleteExternalIdentity(mapping.id)
    message.success(t('externalIdentities.deleteSuccess'))
    await Promise.all([loadMappings(), loadCandidates()])
  } catch (err: any) {
    message.error(err?.message || t('externalIdentities.deleteFailed'))
  }
}

onMounted(() => {
  void loadMappings()
  void loadCandidates()
  void loadUsers()
})
</script>

<template>
  <div class="extid-page">
    <div class="extid-header">
      <h1 class="page-title">{{ t('externalIdentities.title') }}</h1>
      <p class="page-subtitle">{{ t('externalIdentities.subtitle') }}</p>
    </div>

    <section class="extid-section">
      <div class="section-head">
        <h2>{{ t('externalIdentities.mappingsTitle') }}</h2>
        <NButton size="small" :loading="loadingMappings" @click="loadMappings">
          {{ t('externalIdentities.refresh') }}
        </NButton>
      </div>
      <NSpin v-if="loadingMappings && mappings.length === 0" class="extid-spin" />
      <NEmpty
        v-else-if="mappings.length === 0"
        :description="t('externalIdentities.emptyMappings')"
        class="extid-empty"
      />
      <div v-else class="extid-table">
        <div class="extid-row extid-row-head">
          <span>{{ t('externalIdentities.colSource') }}</span>
          <span>{{ t('externalIdentities.colExternalId') }}</span>
          <span>{{ t('externalIdentities.colUser') }}</span>
          <span>{{ t('externalIdentities.colCreatedAt') }}</span>
          <span></span>
        </div>
        <div v-for="m in mappings" :key="m.id" class="extid-row">
          <span><NTag size="small" :type="sourceTagType(m.source)">{{ m.source }}</NTag></span>
          <span class="mono" :title="m.external_id">{{ truncateId(m.external_id) }}</span>
          <span>{{ m.username || m.user_id }}</span>
          <span class="dim">{{ formatTime(m.created_at) }}</span>
          <span class="row-actions">
            <NPopconfirm @positive-click="removeMapping(m)">
              <template #trigger>
                <NButton size="tiny" type="error" quaternary>
                  {{ t('externalIdentities.delete') }}
                </NButton>
              </template>
              {{ t('externalIdentities.confirmDelete') }}
            </NPopconfirm>
          </span>
        </div>
      </div>
    </section>

    <section class="extid-section">
      <div class="section-head">
        <h2>{{ t('externalIdentities.candidatesTitle') }}</h2>
        <NButton size="small" :loading="loadingCandidates" @click="loadCandidates">
          {{ t('externalIdentities.refresh') }}
        </NButton>
      </div>
      <p class="section-hint">{{ t('externalIdentities.candidatesHint') }}</p>
      <NSpin v-if="loadingCandidates && candidates.length === 0" class="extid-spin" />
      <NEmpty
        v-else-if="candidates.length === 0"
        :description="t('externalIdentities.emptyCandidates')"
        class="extid-empty"
      />
      <div v-else class="extid-table candidates">
        <div class="extid-row extid-row-head">
          <span>{{ t('externalIdentities.colSource') }}</span>
          <span>{{ t('externalIdentities.colExternalId') }}</span>
          <span>{{ t('externalIdentities.colSessions') }}</span>
          <span>{{ t('externalIdentities.colUser') }}</span>
          <span></span>
        </div>
        <div
          v-for="c in candidates"
          :key="`${c.source}:${c.external_id}`"
          class="extid-row"
        >
          <span><NTag size="small" :type="sourceTagType(c.source)">{{ c.source }}</NTag></span>
          <span class="mono" :title="c.external_id">{{ truncateId(c.external_id) }}</span>
          <span class="dim">{{ c.session_count }}</span>
          <span class="bind-cell">
            <NSelect
              v-model:value="bindChoices[`${c.source}:${c.external_id}`]"
              :options="userOptions"
              :placeholder="t('externalIdentities.userPlaceholder')"
              size="small"
              filterable
              class="bind-select"
            />
          </span>
          <span class="row-actions">
            <NButton
              size="tiny"
              type="primary"
              quaternary
              :loading="bindingKey === `${c.source}:${c.external_id}`"
              :disabled="userOptions.length === 0"
              @click="bindCandidate(c)"
            >
              {{ t('externalIdentities.bind') }}
            </NButton>
          </span>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.extid-page {
  max-width: 960px;
  margin: 0 auto;
  padding: 20px 16px 48px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.extid-header .page-title {
  font-size: 20px;
  font-weight: 600;
  margin: 0 0 6px;
}

.extid-header .page-subtitle {
  margin: 0;
  opacity: 0.7;
  font-size: 13px;
}

.extid-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.section-head h2 {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
}

.section-hint {
  margin: 0;
  font-size: 12px;
  opacity: 0.65;
}

.extid-spin,
.extid-empty {
  padding: 24px 0;
}

.extid-table {
  border: 1px solid rgba(128, 128, 128, 0.22);
  border-radius: 10px;
  overflow: hidden;
}

.extid-row {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr) 150px 170px 64px;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.14);
  font-size: 13px;
}

.extid-table.candidates .extid-row {
  grid-template-columns: 96px minmax(0, 1fr) 64px 190px 64px;
}

.extid-row:last-child {
  border-bottom: none;
}

.extid-row-head {
  background: rgba(128, 128, 128, 0.08);
  font-weight: 600;
  font-size: 12px;
}

.mono {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dim {
  opacity: 0.65;
}

.bind-cell {
  min-width: 0;
}

.bind-select {
  width: 100%;
}

.row-actions {
  text-align: right;
}

@media (max-width: 720px) {
  .extid-page {
    padding: 14px 10px 40px;
  }

  .extid-row,
  .extid-table.candidates .extid-row {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    row-gap: 8px;
  }

  .extid-row-head {
    display: none;
  }

  .extid-row {
    border-left: none;
    border-right: none;
  }
}
</style>
