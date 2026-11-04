import type { components } from '../../shared/api/generated/schema'
import { ChatKind } from '../../shared/api/generated/socket-vocabulary'

export type Chat = components['schemas']['ChatResponse'] & { unreadCount?: number }

export function chatTitle(chat: Chat, myId: string): string {
  if (chat.kind === ChatKind.GROUP) return chat.name || 'Untitled group'
  return chat.members.find((member) => member.id !== myId)?.username || 'Your notes'
}

export function chatPeer(chat: Chat, myId: string): string | undefined {
  if (chat.kind === ChatKind.GROUP) return undefined
  return chat.members.find((member) => member.id !== myId)?.id
}

export function formatUnread(count: number): string {
  return count > 99 ? '99+' : String(count)
}
