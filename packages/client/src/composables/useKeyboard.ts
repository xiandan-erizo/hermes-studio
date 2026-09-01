import { onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useSessionSearch } from './useSessionSearch'
import { isStoredUser } from '@/api/client'

export function useKeyboard() {
  const router = useRouter()
  const { sessionSearchOpen, openSessionSearch, closeSessionSearch } = useSessionSearch()
  const isPlainUser = isStoredUser()

  function handleKeydown(e: KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey

    if (mod && e.key === 'n') {
      e.preventDefault()
      void import('@/stores/hermes/chat').then(({ useChatStore }) => {
        useChatStore().newChat()
      })
      return
    }

    if (mod && e.key === 'j') {
      if (isPlainUser) return
      e.preventDefault()
      router.push({ name: 'hermes.jobs' })
      return
    }

    if (mod && e.key.toLowerCase() === 'k') {
      if (isPlainUser || router.currentRoute.value.name === 'login') return
      e.preventDefault()
      openSessionSearch()
      return
    }

    if (e.key === 'Escape') {
      if (sessionSearchOpen.value) {
        e.preventDefault()
        closeSessionSearch()
        return
      }
      // Close any open modals — naive-ui handles this internally
      const modal = document.querySelector('.n-modal-mask')
      if (modal) {
        const closeBtn = modal.querySelector('.n-base-close') as HTMLElement
        closeBtn?.click()
      }
    }
  }

  onMounted(() => {
    window.addEventListener('keydown', handleKeydown)
  })

  onUnmounted(() => {
    window.removeEventListener('keydown', handleKeydown)
  })
}
