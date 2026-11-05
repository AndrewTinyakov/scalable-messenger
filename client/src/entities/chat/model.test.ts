import { describe, expect, it } from 'vitest'
import { ChatKind } from '../../shared/api/generated/socket-vocabulary'
import { compareChats, hasUnread, isMuted, withPinnedOrder, type Chat } from './model'

const base: Chat = {
  id: '01ARZ3NDEKTSV4RRFFQ69G5FA0',
  kind: ChatKind.DIRECT,
  members: [],
  memberCount: 2,
  lastSequence: '1',
}
const chat = (id: string, extra: Partial<Chat> = {}): Chat => ({ ...base, id, ...extra })

describe('chat preferences', () => {
  it('orders pinned chats by rank before activity', () => {
    const chats = [
      chat('a', { activityAt: '2026-11-05T10:00:00Z' }),
      chat('b', { pinnedRank: 2, activityAt: '2026-11-01T10:00:00Z' }),
      chat('c', { pinnedRank: 1, activityAt: '2026-10-01T10:00:00Z' }),
      chat('d', { activityAt: '2026-11-05T11:00:00Z' }),
    ]
    expect(chats.sort(compareChats).map((item) => item.id)).toEqual(['c', 'b', 'd', 'a'])
  })

  it('applies a replacement pin order and unpins omitted chats', () => {
    const next = withPinnedOrder(
      [chat('a', { pinnedRank: 1 }), chat('b'), chat('c', { pinnedRank: 2 })],
      ['b', 'a'],
    )
    expect(next.map((item) => [item.id, item.pinnedRank ?? null])).toEqual([
      ['b', 1],
      ['a', 2],
      ['c', null],
    ])
  })

  it('treats expired timed mutes as unmuted and marks as unread', () => {
    const now = Date.parse('2026-11-05T12:00:00Z')
    expect(isMuted(chat('a', { mutedForever: true }), now)).toBe(true)
    expect(isMuted(chat('a', { mutedUntil: '2026-11-05T13:00:00Z' }), now)).toBe(true)
    expect(isMuted(chat('a', { mutedUntil: '2026-11-05T11:00:00Z' }), now)).toBe(false)
    expect(hasUnread(chat('a', { markedUnread: true }))).toBe(true)
    expect(hasUnread(chat('a'))).toBe(false)
  })
})
