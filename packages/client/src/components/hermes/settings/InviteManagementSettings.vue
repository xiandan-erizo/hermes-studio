<script setup lang="ts">
import { computed, h, onMounted, reactive, ref } from 'vue'
import { NButton, NDataTable, NForm, NFormItem, NInputNumber, NModal, NPopconfirm, NSelect, NSpace, NTag, useMessage, type DataTableColumns } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  createInvite,
  fetchInvites,
  revokeInvite,
  type ManagedInvite,
} from '@/api/studio/auth'

const { t } = useI18n()
const message = useMessage()

const loading = ref(false)
const saving = ref(false)
const invites = ref<ManagedInvite[]>([])
const profiles = ref<string[]>([])
const showModal = ref(false)

const form = reactive({
  profile: '' as string,
  expiresInDays: 7,
  maxUses: 0,
})

const profileOptions = computed(() => profiles.value.map(profile => ({ label: profile, value: profile })))

const copiedCode = ref('')

async function loadInvites() {
  loading.value = true
  try {
    const res = await fetchInvites()
    invites.value = res.invites
    profiles.value = res.profiles
  } catch (err: any) {
    message.error(err.message || t('invites.loadFailed'))
  } finally {
    loading.value = false
  }
}

function openCreate() {
  form.profile = ''
  form.expiresInDays = 7
  form.maxUses = 0
  showModal.value = true
}

async function submit() {
  if (!form.profile) {
    message.error(t('invites.profileRequired'))
    return
  }
  saving.value = true
  try {
    await createInvite({
      profile: form.profile,
      expiresInDays: form.expiresInDays,
      maxUses: form.maxUses,
    })
    showModal.value = false
    await loadInvites()
    message.success(t('invites.createSuccess'))
  } catch (err: any) {
    message.error(err.message || t('common.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function removeInvite(row: ManagedInvite) {
  saving.value = true
  try {
    await revokeInvite(row.code)
    await loadInvites()
    message.success(t('invites.revokeSuccess'))
  } catch (err: any) {
    message.error(err.message || t('common.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function copyLink(row: ManagedInvite) {
  try {
    await navigator.clipboard.writeText(row.url)
    copiedCode.value = row.code
    message.success(t('invites.copied'))
    setTimeout(() => {
      if (copiedCode.value === row.code) copiedCode.value = ''
    }, 2000)
  } catch {
    message.error(t('invites.copyFailed'))
  }
}

function formatTime(value: number | null): string {
  if (!value) return '-'
  return new Date(value).toLocaleString()
}

const columns = computed<DataTableColumns<ManagedInvite>>(() => [
  {
    title: t('invites.profile'),
    key: 'profile_name',
    minWidth: 140,
    render: (row) => h(NTag, { size: 'small', bordered: false }, { default: () => row.profile_name }),
  },
  {
    title: t('invites.linkLabel'),
    key: 'url',
    minWidth: 260,
    render: (row) => h('span', { class: 'invite-link', title: row.url }, { default: () => row.url }),
  },
  {
    title: t('invites.statusLabel'),
    key: 'status',
    width: 100,
    render: (row) => h(NTag, {
      size: 'small',
      type: row.status === 'active' ? 'success' : row.status === 'revoked' ? 'error' : 'warning',
    }, {
      default: () => row.status === 'active' ? t('invites.status.active') : row.status === 'revoked' ? t('invites.status.revoked') : t('invites.status.expired'),
    }),
  },
  {
    title: t('invites.uses'),
    key: 'use_count',
    width: 90,
    render: (row) => row.max_uses > 0 ? `${row.use_count} / ${row.max_uses}` : String(row.use_count),
  },
  {
    title: t('invites.expires'),
    key: 'expires_at',
    minWidth: 170,
    render: (row) => row.expires_at ? formatTime(row.expires_at) : t('invites.neverExpires'),
  },
  {
    title: t('invites.createdAt'),
    key: 'created_at',
    minWidth: 170,
    render: (row) => formatTime(row.created_at),
  },
  {
    title: t('common.edit'),
    key: 'actions',
    width: 220,
    fixed: 'right',
    render: (row) => h(NSpace, { size: 8 }, {
      default: () => [
        h(NButton, { size: 'small', onClick: () => copyLink(row) }, { default: () => copiedCode.value === row.code ? t('invites.copied') : t('invites.copy') }),
        ...(row.status === 'active'
          ? [h(NPopconfirm, { onPositiveClick: () => removeInvite(row) }, {
            trigger: () => h(NButton, { size: 'small', type: 'error', ghost: true, loading: saving.value }, { default: () => t('invites.revoke') }),
            default: () => t('invites.revokeConfirm'),
          })]
          : []),
      ],
    }),
  },
])

onMounted(loadInvites)
</script>

<template>
  <div class="invite-management">
    <div class="toolbar">
      <div>
        <h3 class="section-title">{{ t('invites.title') }}</h3>
        <p class="section-desc">{{ t('invites.description') }}</p>
      </div>
      <NButton type="primary" @click="openCreate">{{ t('invites.create') }}</NButton>
    </div>

    <NDataTable
      :columns="columns"
      :data="invites"
      :loading="loading"
      :bordered="false"
      :single-line="false"
      :scroll-x="1080"
      size="small"
    />

    <NModal v-model:show="showModal" preset="card" :title="t('invites.create')" style="max-width: 480px">
      <NForm label-placement="left" label-width="140">
        <NFormItem :label="t('invites.profile')" required>
          <NSelect v-model:value="form.profile" :options="profileOptions" :placeholder="t('invites.profilePlaceholder')" />
        </NFormItem>
        <NFormItem :label="t('invites.expiresInDays')">
          <NInputNumber v-model:value="form.expiresInDays" :min="0" :max="365" style="width: 100%">
            <template #suffix>{{ t('invites.daysUnit') }}</template>
          </NInputNumber>
        </NFormItem>
        <NFormItem :label="t('invites.maxUses')">
          <NInputNumber v-model:value="form.maxUses" :min="0" style="width: 100%">
            <template #suffix>{{ t('invites.maxUsesHint') }}</template>
          </NInputNumber>
        </NFormItem>
        <div class="form-hint">{{ t('invites.formHint') }}</div>
        <div class="form-actions">
          <NButton @click="showModal = false">{{ t('common.cancel') }}</NButton>
          <NButton type="primary" :loading="saving" @click="submit">{{ t('common.save') }}</NButton>
        </div>
      </NForm>
    </NModal>
  </div>
</template>

<style scoped lang="scss">
.invite-management {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.toolbar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.section-title {
  margin: 0 0 4px;
  font-size: 16px;
  font-weight: 600;
}

.section-desc {
  margin: 0;
  font-size: 13px;
  color: var(--text-muted, #888);
}

.invite-link {
  font-family: var(--font-code, monospace);
  font-size: 12px;
  word-break: break-all;
}

.form-hint {
  margin: 8px 0 16px;
  font-size: 12px;
  color: var(--text-muted, #888);
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}
</style>
