<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { getStoredUserId, isStoredUser } from '@/api/client'
import { clearThemeBackgroundCache } from '@/api/studio/theme'

const router = useRouter()
const { t } = useI18n()
const isPlainUser = isStoredUser()

function openSettingsPage() {
  void router.push({ name: 'hermes.settings' })
}

async function handleLogout() {
  const userId = getStoredUserId()
  if (userId) await clearThemeBackgroundCache(userId).catch(() => {})
  localStorage.clear()
  window.location.reload()
}
</script>

<template>
  <div class="page-sidebar-bottom">
    <button v-if="!isPlainUser" class="page-sidebar-menu-btn" type="button" @click="openSettingsPage">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
      <span>{{ t('sidebar.settings') }}</span>
    </button>
    <button v-else class="page-sidebar-menu-btn logout-item" type="button" @click="void handleLogout()">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
        <polyline points="16 17 21 12 16 7" />
        <line x1="21" y1="12" x2="9" y2="12" />
      </svg>
      <span>{{ t('sidebar.logout') }}</span>
    </button>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.page-sidebar-bottom {
  flex-shrink: 0;
  padding: 10px 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.page-sidebar-menu-btn {
  flex: 1 1 auto;
  width: auto;
  min-width: 0;
  height: 36px;
  border: none;
  border-radius: $radius-sm;
  background: transparent;
  color: $text-secondary;
  display: inline-flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  padding: 8px 10px;
  cursor: pointer;
  transition:
    background-color $transition-fast,
    color $transition-fast;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.06);
    color: $text-primary;
  }

  span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    line-height: 18px;
  }
}

</style>
