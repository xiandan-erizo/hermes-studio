import { createRouter, createWebHashHistory } from 'vue-router'
import { hasApiKey, isStoredSuperAdmin, isStoredElevatedUser, isStoredUser } from '@/api/client'
import { hasDesktopBrowserBridge } from '@/utils/desktop-bridge'
import { resolveLoginRedirect } from '@/utils/login-redirect'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/desktop-pet',
      name: 'desktop.pet',
      component: () => import('@/views/hermes/DesktopPetView.vue'),
      meta: { public: true },
    },
    {
      path: '/',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
      meta: { public: true },
    },
    {
      path: '/share/group-chat/:inviteCode?',
      name: 'share.groupChat',
      component: () => import('@/views/hermes/SharedGroupChatView.vue'),
      meta: { public: true, standaloneChat: true, inviteOnly: true },
    },
    {
      path: '/invite/:code',
      name: 'invite.join',
      component: () => import('@/views/InviteView.vue'),
      meta: { public: true },
    },
    {
      path: '/group-chat-link',
      name: 'groupChat.link',
      component: () => import('@/views/hermes/GroupChatLinkView.vue'),
      meta: { standaloneChat: true },
    },
    {
      path: '/hermes/chat',
      name: 'hermes.chat',
      component: () => import('@/views/hermes/ChatView.vue'),
    },
    {
      path: '/hermes/session/:sessionId',
      name: 'hermes.session',
      component: () => import('@/views/hermes/ChatView.vue'),
    },
    {
      path: '/desktop-chat/:sessionId',
      name: 'desktop.chat',
      component: () => import('@/views/hermes/ChatView.vue'),
      meta: { standaloneChat: true },
    },
    {
      path: '/hermes/history',
      name: 'hermes.history',
      component: () => import('@/views/hermes/HistoryView.vue'),
    },
    {
      path: '/hermes/history/session/:sessionId',
      name: 'hermes.historySession',
      component: () => import('@/views/hermes/HistoryView.vue'),
    },
    {
      path: '/hermes/global-agent',
      name: 'hermes.globalAgent',
      component: () => import('@/views/hermes/GlobalAgentView.vue'),
    },
    {
      path: '/hermes/global-agent/session/:sessionId',
      name: 'hermes.globalAgentSession',
      component: () => import('@/views/hermes/GlobalAgentView.vue'),
    },
    {
      path: '/hermes/jobs',
      name: 'hermes.jobs',
      component: () => import('@/views/hermes/JobsView.vue'),
      meta: { hermesConfig: true },
    },
    {
      path: '/hermes/kanban',
      name: 'hermes.kanban',
      component: () => import('@/views/hermes/KanbanView.vue'),
      meta: { hermesConfig: true },
    },
    {
      path: '/hermes/workflow',
      name: 'hermes.workflow',
      component: () => import('@/views/hermes/WorkflowView.vue'),
    },
    {
      path: '/hermes/models',
      name: 'hermes.models',
      component: () => import('@/views/hermes/ChatView.vue'),
    },
    {
      path: '/hermes/profiles',
      name: 'hermes.profiles',
      component: () => import('@/views/hermes/ProfilesView.vue'),
      meta: { requiresSuperAdmin: true },
    },
    {
      path: '/hermes/logs',
      name: 'hermes.logs',
      component: () => import('@/views/hermes/LogsView.vue'),
      meta: { requiresElevated: true },
    },
    {
      path: '/hermes/usage',
      name: 'hermes.usage',
      component: () => import('@/views/hermes/UsageView.vue'),
      meta: { requiresElevated: true },
    },
    {
      path: '/hermes/performance',
      name: 'hermes.performance',
      component: () => import('@/views/hermes/PerformanceView.vue'),
      meta: { requiresSuperAdmin: true },
    },
    {
      path: '/hermes/journey',
      name: 'hermes.journey',
      component: () => import('@/views/hermes/JourneyView.vue'),
      meta: { hermesConfig: true },
    },
    {
      path: '/hermes/skills-usage',
      name: 'hermes.skillsUsage',
      component: () => import('@/views/hermes/SkillsUsageView.vue'),
      meta: { requiresElevated: true },
    },
    {
      path: '/hermes/skills',
      name: 'hermes.skills',
      component: () => import('@/views/hermes/SkillsView.vue'),
      meta: { hermesConfig: true },
    },
    {
      path: '/hermes/plugins',
      name: 'hermes.plugins',
      component: () => import('@/views/hermes/PluginsView.vue'),
      meta: { hermesConfig: true },
    },
    {
      path: '/hermes/petdex',
      name: 'hermes.petdex',
      component: () => import('@/views/hermes/PetdexView.vue'),
    },
    {
      path: '/hermes/marketplace',
      name: 'hermes.marketplace',
      component: () => import('@/views/hermes/MarketplaceView.vue'),
    },
    {
      path: '/hermes/memory',
      name: 'hermes.memory',
      component: () => import('@/views/hermes/MemoryView.vue'),
      meta: { hermesConfig: true },
    },
    {
      path: '/hermes/config/settings',
      name: 'hermes.configSettings',
      component: () => import('@/views/hermes/HermesSettingsView.vue'),
      meta: { hermesConfig: true },
    },
    {
      path: '/hermes/settings',
      name: 'hermes.settings',
      component: () => import('@/views/hermes/SettingsView.vue'),
    },
    {
      path: '/hermes/theme',
      name: 'hermes.theme',
      component: () => import('@/views/hermes/ThemeView.vue'),
    },
    {
      path: '/hermes/channels',
      name: 'hermes.channels',
      component: () => import('@/views/hermes/ChannelsView.vue'),
      meta: { hermesConfig: true },
    },
    {
      path: '/social-messages',
      redirect: {
        name: 'hermes.connections',
        query: { view: 'messages' },
      },
    },
    {
      path: '/hermes/terminal',
      name: 'hermes.terminal',
      component: () => import('@/views/hermes/TerminalView.vue'),
      meta: { requiresSuperAdmin: true },
    },
    {
      path: '/hermes/connections',
      name: 'hermes.connections',
      component: () => import('@/views/hermes/ChatView.vue'),
    },
    {
      path: '/hermes/devices',
      name: 'hermes.devices',
      redirect: to => ({
        name: 'hermes.connections',
        query: { ...to.query, tab: 'devices' },
      }),
      meta: { requiresSuperAdmin: true },
    },
    {
      path: '/studio/agents',
      name: 'hermes.agentManager',
      component: () => import('@/views/hermes/ChatView.vue'),
      meta: { requiresSuperAdmin: true },
    },
    {
      path: '/ekko/memory',
      name: 'ekko.memory',
      component: () => import('@/views/ekko/MemoryView.vue'),
      meta: { ekkoConfig: true, requiresSuperAdmin: true },
    },
    {
      path: '/ekko/skills',
      name: 'ekko.skills',
      component: () => import('@/views/ekko/SkillsView.vue'),
      meta: { ekkoConfig: true, requiresSuperAdmin: true },
    },
    {
      path: '/ekko/mcp',
      name: 'ekko.mcp',
      component: () => import('@/views/ekko/McpView.vue'),
      meta: { ekkoConfig: true, requiresSuperAdmin: true },
    },
    {
      path: '/ekko/settings',
      name: 'ekko.settings',
      component: () => import('@/views/ekko/SettingsView.vue'),
      meta: { ekkoConfig: true, requiresSuperAdmin: true },
    },
    {
      path: '/hermes/agents',
      redirect: { name: 'hermes.agentManager' },
    },
    {
      path: '/hermes/group-chat',
      name: 'hermes.groupChat',
      component: () => import('@/views/hermes/GroupChatView.vue'),
    },
    {
      path: '/hermes/group-chat/room/:roomId',
      name: 'hermes.groupChatRoom',
      component: () => import('@/views/hermes/GroupChatView.vue'),
    },
    {
      path: '/hermes/history/group-chat/:roomId',
      redirect: to => ({
        name: 'hermes.groupChatRoom',
        params: { roomId: to.params.roomId },
      }),
    },
    {
      path: '/hermes/group-chat/history/:roomId',
      redirect: to => ({
        name: 'hermes.groupChatRoom',
        params: { roomId: to.params.roomId },
      }),
    },
    {
      path: '/hermes/files',
      name: 'hermes.files',
      component: () => import('@/views/hermes/FilesView.vue'),
    },
    {
      path: '/hermes/coding-agents',
      name: 'hermes.codingAgents',
      redirect: { name: 'hermes.agentManager' },
    },
    {
      path: '/hermes/version-preview',
      name: 'hermes.versionPreview',
      component: () => import('@/views/hermes/VersionPreviewView.vue'),
      meta: { requiresSuperAdmin: true },
    },
    {
      path: '/hermes/mcp',
      name: 'hermes.mcp',
      component: () => import('@/views/hermes/McpManagerView.vue'),
      meta: { hermesConfig: true },
    },
  ],
})

const PLAIN_USER_ALLOWED_ROUTES = new Set([
  'hermes.chat',
  'hermes.session',
  'hermes.history',
  'hermes.historySession',
])

// Desktop exposes a dedicated settings page. Actual browsing stays inside the
// chat tool panel so this route never creates or positions a WebContentsView.
if (hasDesktopBrowserBridge()) {
  router.addRoute({
    path: '/hermes/browser',
    name: 'hermes.browser',
    component: () => import('@/views/hermes/DesktopBrowserView.vue'),
  })
}

async function ensureDesktopAuth(): Promise<void> {
  if (hasApiKey()) return
  const bridge = (window as typeof window & {
    hermesDesktop?: { isDesktop?: boolean; ensureAuth?: () => Promise<boolean> }
  }).hermesDesktop
  if (bridge?.isDesktop === true && bridge.ensureAuth) {
    await bridge.ensureAuth().catch(() => false)
  }
}

function isDesktopShell(): boolean {
  return (window as typeof window & {
    hermesDesktop?: { isDesktop?: boolean }
  }).hermesDesktop?.isDesktop === true
}

router.beforeEach(async (to, _from, next) => {
  await ensureDesktopAuth()

  // Public pages don't need auth
  if (to.meta.public) {
    // Already has key, skip login
    if (to.name === 'login' && hasApiKey() && !isDesktopShell()) {
      next(resolveLoginRedirect(to.query.redirect))
      return
    }
    next()
    return
  }

  // All other pages require token
  if (!hasApiKey()) {
    next({ name: 'login', query: { redirect: to.fullPath } })
    return
  }

  if (isStoredUser() && !PLAIN_USER_ALLOWED_ROUTES.has(String(to.name || ''))) {
    next({ name: 'hermes.chat' })
    return
  }

  if (to.meta.requiresSuperAdmin && !isStoredSuperAdmin()) {
    next({ name: 'hermes.chat' })
    return
  }

  // Plain 'user' accounts stay out of management pages. hermesConfig pages
  // are the dedicated Hermes-only sidebar (admins only by design).
  if ((to.meta.requiresElevated || to.meta.hermesConfig) && !isStoredElevatedUser()) {
    next({ name: 'hermes.chat' })
    return
  }

  next()
})

export default router
