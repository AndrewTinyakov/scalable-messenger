import { describe, expect, it } from 'vitest'
import { decodePinnedMessages } from './featureDecode'

const chatId = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const id = (suffix: string) => `01ARZ3NDEKTSV4RRFFQ69G5F${suffix}`
const message = (messageId: string, sequence: string) => ({
  id: messageId,
  chatId,
  sequence,
  senderId: id('AW'),
  body: 'pinned',
  createdAt: '2026-11-05T10:00:00Z',
  messageVersion: '1',
  editedAt: null,
  deletedAt: null,
  replyToMessageId: null,
  replySenderId: null,
  replyBody: null,
  replyDeleted: null,
  replyVersion: null,
})

describe('pinned message pages', () => {
  it('keeps every pinned identity beyond the loaded page', () => {
    const page = decodePinnedMessages(
      {
        pins: [{ message: message(id('B1'), '9'), scope: 'EVERYONE' }],
        totalCount: 2,
        pinnedMessageIds: [id('B1'), id('B2')],
        nextBeforeSequence: '9',
      },
      chatId,
    )
    expect(page.pinnedMessageIds).toEqual([id('B1'), id('B2')])
  })

  it('rejects identity lists that disagree with the page or the count', () => {
    const base = {
      pins: [{ message: message(id('B1'), '9'), scope: 'SELF' }],
      totalCount: 1,
      pinnedMessageIds: [id('B1')],
      nextBeforeSequence: null,
    }
    expect(() => decodePinnedMessages({ ...base, pinnedMessageIds: [id('B2')] }, chatId)).toThrow()
    expect(() => decodePinnedMessages({ ...base, totalCount: 2 }, chatId)).toThrow()
    expect(() => decodePinnedMessages({ ...base, pinnedMessageIds: undefined }, chatId)).toThrow()
    expect(() =>
      decodePinnedMessages({ ...base, pins: [{ ...base.pins[0], scope: 'GROUP' }] }, chatId),
    ).toThrow()
  })
})
