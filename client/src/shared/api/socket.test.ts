import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeSocketEvent, sendSocketFrame } from './socket'

afterEach(() => vi.unstubAllGlobals())

const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const message = {
  type: 'message_saved',
  version: 1,
  eventId: id,
  room: `group:${id}`,
  chatId: id,
  requestId: id,
  messageId: id,
  sequence: '9007199254740993',
  senderId: id,
  body: '<script>alert(1)</script>',
  createdAt: '2026-09-28T10:00:00Z',
  epoch: 'epoch',
  streamId: '1727524800000-0',
}

describe('socket output', () => {
  it('closes a stalled connection before UTF-8 output exceeds its queue bound', () => {
    const send = vi.fn()
    const close = vi.fn()
    vi.stubGlobal(
      'WebSocket',
      class {
        bufferedAmount = 1040000
        send = send
        close = close
      },
    )
    const socket = new WebSocket('ws://localhost/ws')
    expect(() =>
      sendSocketFrame(socket, {
        type: 'send',
        version: 1,
        chatId: id,
        requestId: id,
        body: '😀'.repeat(4000),
      }),
    ).toThrow('Connection is busy. Try again.')
    expect(send).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledWith(4009, 'Outgoing queue is full')
  })
})

describe('socket event decoding', () => {
  it.each(['history-changed', 'message-saved-reply-identity'])(
    'accepts the shared %s fixture and rejects malformed snapshot fields',
    (name) => {
      const fixture = {
        ...JSON.parse(
          readFileSync(
            new URL(`../../../../contracts/fixtures/valid/${name}.json`, import.meta.url),
            'utf8',
          ),
        ),
        epoch: 'epoch',
        streamId: '1-0',
      } as Record<string, unknown>
      expect(decodeSocketEvent(JSON.stringify(fixture))).toEqual(fixture)
      if (name === 'history-changed')
        for (const field of ['sequence', 'mutationRevision', 'visibilityRevision']) {
          expect(decodeSocketEvent(JSON.stringify({ ...fixture, [field]: undefined }))).toBeNull()
          expect(
            decodeSocketEvent(JSON.stringify({ ...fixture, [field]: '9223372036854775808' })),
          ).toBeNull()
        }
      else
        for (const fields of [
          { replyBody: 'partial quote' },
          { replySenderId: id },
          { replyDeleted: true },
          { replyVersion: '1' },
        ])
          expect(decodeSocketEvent(JSON.stringify({ ...fixture, ...fields }))).toBeNull()
    },
  )
  it('preserves message text and lossless chat sequences from a valid saved event', () => {
    expect(decodeSocketEvent(JSON.stringify(message))).toEqual(message)
  })

  it('keeps saved events within the creation and reply wire contract', () => {
    const reply = {
      replyToMessageId: id,
      replySenderId: id,
      replyBody: 'quote',
      replyDeleted: false,
      replyVersion: '1',
    }
    for (const fields of [
      { messageVersion: null },
      { ...reply, replyBody: '' },
      { ...reply, replyVersion: null },
      { replyToMessageId: null },
      { body: '', deletedAt: '2026-11-04T10:01:00Z' },
      { editedAt: '2026-11-04T10:01:00Z' },
    ])
      expect(decodeSocketEvent(JSON.stringify({ ...message, ...fields }))).toBeNull()
    expect(decodeSocketEvent(JSON.stringify({ ...message, ...reply }))).not.toBeNull()
    expect(
      decodeSocketEvent(
        JSON.stringify({ ...message, ...reply, replyDeleted: true, replyBody: '' }),
      ),
    ).not.toBeNull()
    expect(decodeSocketEvent(JSON.stringify(message))).toEqual(message)
  })

  it('rejects nullable HTTP-only fields in changed events while accepting omitted optional fields', () => {
    const { requestId: _requestId, ...saved } = message
    const changed = {
      ...saved,
      type: 'message_changed',
      messageVersion: '2',
      mutationRevision: '1',
    }
    expect(decodeSocketEvent(JSON.stringify(changed))).toEqual(changed)
    for (const fields of [
      { editedAt: null },
      { deletedAt: null },
      { replyToMessageId: null },
      {
        replyToMessageId: null,
        replySenderId: null,
        replyBody: null,
        replyDeleted: null,
        replyVersion: null,
      },
    ])
      expect(decodeSocketEvent(JSON.stringify({ ...changed, ...fields }))).toBeNull()
    const deleted = { ...changed, body: '', deletedAt: '2026-11-04T10:01:00Z' }
    expect(decodeSocketEvent(JSON.stringify(deleted))).toEqual(deleted)
  })

  it('ignores malformed frames before they reach recovery state', () => {
    const invalid = [
      'not json',
      'null',
      '[]',
      '1',
      '{"type":42}',
      JSON.stringify({ ...message, version: 2 }),
      JSON.stringify({ ...message, sequence: 'invalid' }),
      JSON.stringify({ ...message, sequence: '9223372036854775808' }),
      JSON.stringify({ ...message, sequence: '0' }),
      JSON.stringify({ ...message, senderId: '__proto__' }),
      JSON.stringify({ ...message, body: {} }),
      JSON.stringify({ ...message, body: 'x'.repeat(4001) }),
      JSON.stringify({ ...message, createdAt: 'not a date' }),
      JSON.stringify({ ...message, createdAt: '1' }),
      JSON.stringify({ ...message, createdAt: '2026-02-30T10:00:00Z' }),
      JSON.stringify({ ...message, createdAt: '2026-09-28T24:00:00Z' }),
      JSON.stringify({ ...message, createdAt: '2026-09-28T10:00:00' }),
      JSON.stringify({ ...message, createdAt: '2026-09-28T10:00:00+24:00' }),
      JSON.stringify({ ...message, additional: 'unexpected' }),
      JSON.stringify({ ...message, streamId: 'invalid' }),
      JSON.stringify({ ...message, epoch: null }),
      JSON.stringify({ ...message, type: 'unexpected' }),
    ]
    for (const data of invalid) expect(decodeSocketEvent(data), data).toBeNull()
  })

  it('decodes control frames without requiring live event metadata', () => {
    const controls = [
      { type: 'queued', version: 1, requestId: id, recipientId: id },
      { type: 'subscribed', version: 1, chatId: id, room: `user:${id}` },
      { type: 'error', version: 1, requestId: id, code: 'publish_unknown' },
      { type: 'recovery_failed', version: 1, chatId: id },
      { type: 'subscription_expired', version: 1, chatId: id },
    ]
    for (const frame of controls) expect(decodeSocketEvent(JSON.stringify(frame))).toEqual(frame)
  })

  it('rejects fields belonging to a different frame type', () => {
    const controls = [
      { type: 'queued', version: 1, requestId: id, recipientId: id, epoch: 'unexpected' },
      { type: 'subscribed', version: 1, chatId: id, room: `user:${id}`, requestId: id },
      { type: 'error', version: 1, code: 'publish_unknown', body: 'unexpected' },
      { type: 'recovery_failed', version: 1, chatId: id, sequence: '1' },
      { type: 'subscription_expired', version: 1, chatId: id, room: `user:${id}` },
      {
        type: 'chat_created',
        version: 1,
        eventId: id,
        room: `user:${id}`,
        chatId: id,
        epoch: 'epoch',
        streamId: '1-0',
        body: 'unexpected',
      },
      {
        type: 'member_removed',
        version: 1,
        eventId: id,
        room: `user:${id}`,
        chatId: id,
        memberId: id,
        epoch: 'epoch',
        streamId: '1-0',
        requestId: id,
      },
      {
        type: 'send_rejected',
        version: 1,
        eventId: id,
        room: `user:${id}`,
        requestId: id,
        chatId: id,
        reason: 'NOT_A_MEMBER',
        epoch: 'epoch',
        streamId: '1-0',
        sequence: '1',
      },
    ]
    for (const frame of controls) expect(decodeSocketEvent(JSON.stringify(frame))).toBeNull()
  })

  it('accepts leap days, offsets and nanosecond timestamps emitted by the transports', () => {
    for (const createdAt of [
      '2024-02-29T23:59:59Z',
      '2026-09-28T10:00:00.123456789Z',
      '2026-09-28T10:00:00+03:00',
    ]) {
      expect(decodeSocketEvent(JSON.stringify({ ...message, createdAt }))).toEqual({
        ...message,
        createdAt,
      })
    }
  })

  it('accepts membership changes only for the named group room', () => {
    const frame = {
      type: 'membership_changed',
      version: 1,
      eventId: id,
      room: `group:${id}`,
      chatId: id,
      epoch: 'epoch',
      streamId: '1-0',
    }
    expect(decodeSocketEvent(JSON.stringify(frame))).toEqual(frame)
    for (const invalid of [
      { ...frame, room: `user:${id}` },
      { ...frame, room: 'group:01ARZ3NDEKTSV4RRFFQ69G5FAW' },
      { ...frame, memberId: id },
      { ...frame, chatId: 'invalid' },
    ])
      expect(decodeSocketEvent(JSON.stringify(invalid))).toBeNull()
  })

  it('accepts member removal only for the named personal or group room', () => {
    const frame = {
      type: 'member_removed',
      version: 1,
      eventId: id,
      room: `user:${id}`,
      chatId: id,
      memberId: id,
      epoch: 'epoch',
      streamId: '1-0',
    }
    expect(decodeSocketEvent(JSON.stringify(frame))).toEqual(frame)
    const group = { ...frame, room: `group:${id}` }
    expect(decodeSocketEvent(JSON.stringify(group))).toEqual(group)
    expect(
      decodeSocketEvent(JSON.stringify({ ...group, room: 'group:01ARZ3NDEKTSV4RRFFQ69G5FAW' })),
    ).toBeNull()
    expect(decodeSocketEvent(JSON.stringify({ ...frame, memberId: undefined }))).toBeNull()
    expect(
      decodeSocketEvent(JSON.stringify({ ...frame, memberId: '01ARZ3NDEKTSV4RRFFQ69G5FAW' })),
    ).toBeNull()
  })
})
