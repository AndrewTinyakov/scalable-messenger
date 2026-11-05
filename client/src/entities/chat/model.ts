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

export type ChatPreferences = Pick<
  Chat,
  'pinnedRank' | 'mutedUntil' | 'mutedForever' | 'markedUnread'
>

export function hasUnread(chat: Chat): boolean {
  return (chat.unreadCount ?? 0) > 0 || Boolean(chat.markedUnread)
}

export function isMuted(chat: Chat, now = Date.now()): boolean {
  return (
    Boolean(chat.mutedForever) || (chat.mutedUntil != null && Date.parse(chat.mutedUntil) > now)
  )
}

export function isPinned(chat: Chat): boolean {
  return chat.pinnedRank != null
}

export function compareChats(left: Chat, right: Chat): number {
  if (left.pinnedRank != null || right.pinnedRank != null)
    return (
      (left.pinnedRank ?? Infinity) - (right.pinnedRank ?? Infinity) ||
      right.id.localeCompare(left.id)
    )
  return (
    Date.parse(right.activityAt ?? '1970-01-01T00:00:00Z') -
      Date.parse(left.activityAt ?? '1970-01-01T00:00:00Z') || right.id.localeCompare(left.id)
  )
}

export function withPinnedOrder(chats: Chat[], order: string[]): Chat[] {
  const ranks = new Map(order.map((id, index) => [id, index + 1]))
  return chats
    .map((chat) =>
      (ranks.get(chat.id) ?? null) === (chat.pinnedRank ?? null)
        ? chat
        : { ...chat, pinnedRank: ranks.get(chat.id) ?? null },
    )
    .sort(compareChats)
}

export function formatUnread(count: number, capped = false): string {
  if (count > 99) return '99+'
  return capped ? `${count}+` : String(count)
}
