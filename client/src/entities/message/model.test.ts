import { describe, expect, it } from 'vitest'
import { advanceSend, mergeMessages, type Message, type PendingSend } from './model'

const pending: PendingSend = {
  chatId: 'chat', requestId: 'request', body: 'Hi', createdAt: '2026-09-26T10:00:00Z', status: 'sending',
}

function message(id: string, sequence: string): Message {
  return { id, chatId: 'chat', sequence, senderId: 'user', body: id, createdAt: '2026-09-26T10:00:00Z' }
}

describe('message state', () => {
  it('keeps a final saved result when a queued receipt arrives later', () => {
    const saved = advanceSend(pending, 'saved', { messageId: 'message' })
    expect(advanceSend(saved, 'queued')).toEqual(saved)
  })

  it('merges replayed events by message ID and orders 64-bit sequences exactly', () => {
    const current = [message('second', '9007199254740994')]
    const incoming = [message('first', '9007199254740993'), message('second', '9007199254740994')]
    expect(mergeMessages(current, incoming).map((item) => item.id)).toEqual(['first', 'second'])
  })
})
