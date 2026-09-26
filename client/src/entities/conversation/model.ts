import type { components } from '../../shared/api/generated/schema'

export type Conversation = Omit<components['schemas']['ConversationView'], 'kind' | 'name'> & {
  kind: 'direct' | 'group'
  name?: string | null
}

export function conversationTitle(conversation: Conversation, myId: string): string {
  if (conversation.kind === 'group') return conversation.name || 'Untitled group'
  return conversation.members.find((member) => member.id !== myId)?.username || 'Your notes'
}

export function conversationInitials(conversation: Conversation, myId: string): string {
  return conversationTitle(conversation, myId)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('')
}
