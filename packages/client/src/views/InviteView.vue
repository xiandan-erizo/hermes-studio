<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { setApiKey, hasApiKey } from '@/api/client'
import {
  acceptInviteWithCurrentAccount,
  acceptInviteWithRegistration,
  buildSsoRedirectUrl,
  fetchInviteInfo,
  fetchSsoStatus,
  type InviteInfo,
} from '@/api/studio/auth'
import { resolveLoginRedirect } from '@/utils/login-redirect'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

const inviteCode = String(route.params.code || '')
const invite = ref<InviteInfo | null>(null)
const loading = ref(true)
const joining = ref(false)
const loggedIn = ref(false)
const ssoEnabled = ref(false)
const errorMsg = ref('')
const username = ref('')
const password = ref('')
const confirmPassword = ref('')

onMounted(async () => {
  loggedIn.value = hasApiKey()
  try {
    const [info, sso] = await Promise.all([
      fetchInviteInfo(inviteCode),
      fetchSsoStatus().catch(() => ({ enabled: false })),
    ])
    invite.value = info
    ssoEnabled.value = sso.enabled
  } catch (err: any) {
    errorMsg.value = err.message || t('invite.invalid')
  } finally {
    loading.value = false
  }
})

async function handleRegister() {
  if (!username.value.trim() || !password.value) {
    errorMsg.value = t('login.credentialsRequired')
    return
  }
  if (password.value.length < 6) {
    errorMsg.value = t('login.passwordTooShort')
    return
  }
  if (password.value !== confirmPassword.value) {
    errorMsg.value = t('login.passwordMismatch')
    return
  }
  joining.value = true
  errorMsg.value = ''
  try {
    const session = await acceptInviteWithRegistration(inviteCode, username.value.trim(), password.value)
    setApiKey(session.token)
    router.replace(resolveLoginRedirect(route.query.redirect))
  } catch (err: any) {
    errorMsg.value = err.message || t('invite.joinFailed')
  } finally {
    joining.value = false
  }
}

async function handleJoinWithAccount() {
  joining.value = true
  errorMsg.value = ''
  try {
    await acceptInviteWithCurrentAccount(inviteCode)
    router.replace(resolveLoginRedirect(route.query.redirect))
  } catch (err: any) {
    errorMsg.value = err.message || t('invite.joinFailed')
  } finally {
    joining.value = false
  }
}

function handleSso() {
  window.location.href = buildSsoRedirectUrl(inviteCode)
}
</script>

<template>
  <div class="invite-view">
    <div class="invite-card">
      <div class="invite-logo">
        <img src="/logo.png" alt="Hermes" width="80" height="80" />
      </div>

      <template v-if="loading">
        <p class="invite-desc">{{ t('common.loading') }}</p>
      </template>

      <template v-else-if="invite && invite.status === 'active'">
        <h1 class="invite-title">{{ t('invite.title') }}</h1>
        <p class="invite-desc">
          {{ t('invite.description') }}
          <span class="invite-profile">{{ invite.profile }}</span>
        </p>

        <form class="invite-form" @submit.prevent="handleRegister">
          <input
            v-model="username"
            type="text"
            class="invite-input"
            :placeholder="t('login.usernamePlaceholder')"
            autofocus
          />
          <input
            v-model="password"
            type="password"
            class="invite-input"
            :placeholder="t('login.passwordPlaceholder')"
          />
          <input
            v-model="confirmPassword"
            type="password"
            class="invite-input"
            :placeholder="t('invite.confirmPasswordPlaceholder')"
          />

          <div v-if="errorMsg" class="invite-error">{{ errorMsg }}</div>

          <button type="submit" class="invite-btn" :disabled="joining">
            {{ joining ? "..." : t('invite.submit') }}
          </button>
        </form>

        <div v-if="ssoEnabled" class="invite-divider">
          <span>{{ t('login.orDivider') }}</span>
        </div>
        <button v-if="ssoEnabled" class="invite-btn invite-btn-sso" @click="handleSso">
          {{ t('login.ssoLogin') }}
        </button>

        <button
          v-if="loggedIn"
          class="invite-link-btn"
          :disabled="joining"
          @click="handleJoinWithAccount"
        >
          {{ t('invite.joinWithCurrentAccount') }}
        </button>
      </template>

      <template v-else>
        <h1 class="invite-title">{{ t('invite.unavailableTitle') }}</h1>
        <p class="invite-desc">{{ invite ? t('invite.unavailable', { status: invite.status }) : (errorMsg || t('invite.invalid')) }}</p>
        <button class="invite-btn" @click="router.replace({ name: 'login' })">
          {{ t('invite.backToLogin') }}
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.invite-view {
  height: calc(100 * var(--vh));
  display: flex;
  align-items: center;
  justify-content: center;
  background: $bg-primary;
}

.invite-card {
  width: 480px;
  max-width: calc(100vw - 32px);
  padding: 56px;
  border: 1px solid $border-color;
  border-radius: $radius-lg;
  background: $bg-card;
  text-align: center;

  @media (max-width: $breakpoint-mobile) {
    padding: 32px 24px;
  }
}

.invite-logo {
  margin-bottom: 24px;
}

.invite-title {
  font-size: 24px;
  font-weight: 600;
  color: $text-primary;
  margin: 0 0 10px;
}

.invite-desc {
  font-size: 14px;
  color: $text-muted;
  margin: 0 0 24px;
  line-height: 1.6;
}

.invite-profile {
  color: $text-primary;
  font-family: $font-code;
}

.invite-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.invite-input {
  width: 100%;
  padding: 14px 16px;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  font-size: 15px;
  color: $text-primary;
  background: $bg-input;
  outline: none;
  transition: border-color $transition-fast;
  box-sizing: border-box;
  font-family: $font-code;

  &::placeholder {
    color: $text-muted;
  }

  &:focus {
    border-color: $accent-primary;
  }
}

.invite-error {
  font-size: 13px;
  color: $error;
  text-align: start;
}

.invite-btn {
  width: 100%;
  padding: 14px;
  border: none;
  border-radius: $radius-sm;
  background: $text-primary;
  color: var(--text-on-accent);
  font-size: 15px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity $transition-fast;

  &:hover {
    opacity: 0.85;
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}

.invite-btn-sso {
  margin-top: 14px;
  background: $bg-input;
  color: $text-primary;
  border: 1px solid $border-color;
}

.invite-divider {
  margin: 20px 0 0;
  display: flex;
  align-items: center;
  gap: 12px;
  color: $text-muted;
  font-size: 12px;

  &::before,
  &::after {
    content: "";
    flex: 1;
    height: 1px;
    background: $border-color;
  }
}

.invite-link-btn {
  margin-top: 16px;
  width: 100%;
  padding: 10px;
  border: none;
  background: transparent;
  color: $text-secondary;
  font-size: 13px;
  cursor: pointer;
  text-decoration: underline;

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}
</style>
