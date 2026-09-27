import type { components } from '../../shared/api/generated/schema'

export type Chat = Omit<components['schemas']['ChatResponse'], 'kind' | 'name'> & {
  kind: 'direct' | 'group'
  name?: string | null
}

export function chatTitle(chat: Chat, myId: string): string {
  if (chat.kind === 'group') return chat.name || 'Untitled group'
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
