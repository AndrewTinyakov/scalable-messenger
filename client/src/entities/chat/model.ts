import type { components } from '../../shared/api/generated/schema'
import { ChatKind } from '../../shared/api/generated/socket-vocabulary'

export type Chat = components['schemas']['ChatResponse']

export function chatTitle(chat: Chat, myId: string): string {
  if (chat.kind === ChatKind.GROUP) return chat.name || 'Untitled group'
  return chat.members.find((member) => member.id !== myId)?.username || 'Your notes'
}

export function chatPeer(chat: Chat, myId: string): string | undefined {
  if (chat.kind === ChatKind.GROUP) return undefined
  return chat.members.find((member) => member.id !== myId)?.id
}

export function hasUnread(chat: Chat): boolean {
  return (chat.unreadCount ?? 0) > 0
}

export function formatUnread(count: number, capped = false): string {
  if (count > 99) return '99+'
  return capped ? `${count}+` : String(count)
}
