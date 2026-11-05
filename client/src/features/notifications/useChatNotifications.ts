import { useEffect, useRef } from 'react'
import { chatTitle, isMuted, type Chat } from '../../entities/chat/model'
import { ChatKind } from '../../shared/api/generated/socket-vocabulary'
import { currentNotificationSettings, notificationPermission } from './notificationSettings'
import { playNotificationSound } from './notificationSound'

interface Options {
  chats: Chat[]
  userId: string
  liveChatId: string | null
  ready: boolean
  onOpen(chatId: string): void
}

const NEW_CHAT_WINDOW_MS = 60_000

export function useChatNotifications({ chats, userId, liveChatId, ready, onOpen }: Options) {
  const seen = useRef<Map<string, bigint> | null>(null)
  const openRef = useRef(onOpen)
  openRef.current = onOpen

  useEffect(() => {
    if (!ready) return
    const previous = seen.current
    const next = new Map<string, bigint>()
    const arrivals: Chat[] = []
    for (const chat of chats) {
      const last = chat.lastMessage
      const sequence = BigInt(last?.sequence ?? chat.lastSequence)
      const known = previous?.get(chat.id)
      next.set(chat.id, known !== undefined && known > sequence ? known : sequence)
      if (!previous || !last || last.deleted || last.senderId === userId) continue
      const fresh =
        known === undefined
          ? Date.now() - Date.parse(last.createdAt) < NEW_CHAT_WINDOW_MS
          : known < BigInt(last.sequence)
      if (!fresh) continue
      if ((chat.unreadCount ?? 0) === 0 || isMuted(chat)) continue
      if (chat.id === liveChatId && document.visibilityState === 'visible') continue
      arrivals.push(chat)
    }
    seen.current = next
    if (!arrivals.length) return
    const settings = currentNotificationSettings()
    if (settings.sound) playNotificationSound()
    if (!settings.desktop || notificationPermission() !== 'granted') return
    if (document.visibilityState === 'visible' && document.hasFocus()) return
    for (const chat of arrivals.slice(0, 3)) {
      const last = chat.lastMessage!
      try {
        const notification = new Notification(chatTitle(chat, userId), {
          body: `${chat.kind === ChatKind.GROUP ? `${last.senderUsername}: ` : ''}${last.bodyPreview}`,
          tag: `chat:${chat.id}`,
        })
        notification.onclick = () => {
          window.focus()
          openRef.current(chat.id)
          notification.close()
        }
      } catch {}
    }
  }, [chats, userId, liveChatId, ready])
}
