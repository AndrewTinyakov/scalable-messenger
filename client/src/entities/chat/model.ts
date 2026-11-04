import type { components } from '../../shared/api/generated/schema'
import { ChatKind } from '../../shared/api/generated/socket-vocabulary'

export type Chat = components['schemas']['ChatResponse']

export function chatTitle(chat: Chat, myId: string): string {
  if (chat.kind === ChatKind.GROUP) return chat.name || 'Untitled group'
  return chat.members.find((member) => member.id !== myId)?.username || 'Your notes'
}

export function chatInitials(chat: Chat, myId: string): string {
  return chatTitle(chat, myId)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('')
}
