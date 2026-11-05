import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PendingSend } from './model'
import { SendRequests, type SendRequestAdapters, type SendResult } from './sendRequests'

function id(index: number): string {
  return String(index).padStart(26, '0')
}
const chatId = id(10000)
const recipientId = id(10001)
const resolvedChatId = id(10002)
const messageId = id(10003)
const draftChatId = `draft:${recipientId}`

function setup(initial: PendingSend[] = []) {
  const values = new Map<string, string>([['relay.user.device.pending', JSON.stringify(initial)]])
  const sent: PendingSend[] = []
  const changes: PendingSend[][] = []
  const statuses = vi.fn(
    async (requestIds: string[]): Promise<{ requestId: string; result: SendResult }[]> =>
      requestIds.map((requestId) => ({ requestId, result: { status: 'UNKNOWN' } })),
  )
  const status = vi.fn(async (): Promise<SendResult> => ({ status: 'UNKNOWN' }))
  let connected = true
  let time = Date.parse('2026-09-28T10:00:00Z')
  let nextId = 0
  const adapters: SendRequestAdapters = {
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value)
      },
    },
    statuses,
    status,
    send: (send) => {
      sent.push(send)
    },
    isConnected: () => connected,
    createId: () => id(++nextId),
    now: () => time,
    onChange: (sends) => {
      changes.push(sends)
    },
  }
  const requests = new SendRequests('relay.user.device', adapters)
  return {
    requests,
    adapters,
    values,
    sent,
    changes,
    statuses,
    status,
    disconnect: () => {
      connected = false
    },
    connect: () => {
      connected = true
    },
    advanceTime: (milliseconds: number) => {
      time += milliseconds
    },
  }
}

function pending(
  requestId: string,
  status: PendingSend['status'] = 'sending',
  targetChatId = chatId,
): PendingSend {
  return {
    requestId,
    chatId: targetChatId,
    body: 'Hello',
    createdAt: '2026-09-28T10:00:00Z',
    status,
  }
}

afterEach(() => vi.useRealTimers())

describe('send requests', () => {
  it('holds later persisted intents behind a queued request until its SQL result is known', async () => {
    const fixture = setup([pending(id(1), 'queued'), pending(id(2))])
    await fixture.requests.reconcile(true)
    expect(fixture.sent.map((send) => send.requestId)).toEqual([id(1)])
    fixture.requests.saved(id(1), chatId, messageId)
    expect(fixture.sent.map((send) => send.requestId)).toEqual([id(1), id(2)])
  })

  it('retries lost confirmations with the same ID and holds other chats after the bound', async () => {
    vi.useFakeTimers()
    const fixture = setup()
    fixture.adapters.now = Date.now
    fixture.requests.start(chatId, 'first')
    fixture.requests.start(resolvedChatId, 'second')
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(10000)
    expect(fixture.sent.map((send) => send.requestId)).toEqual([id(1), id(1), id(1), id(1)])
    expect(fixture.requests.list()[0].status).toBe('retryable')
    await fixture.requests.retry(id(1))
    expect(fixture.sent.at(-1)?.requestId).toBe(id(1))
    fixture.requests.saved(id(1), chatId, messageId)
    await vi.advanceTimersByTimeAsync(75)
    expect(fixture.sent.at(-1)?.body).toBe('second')
  })

  it('hands a save found by the confirmation watchdog to the resolver', async () => {
    vi.useFakeTimers()
    const fixture = setup()
    fixture.adapters.now = Date.now
    const resolved = vi.fn()
    fixture.requests.resolved = resolved
    fixture.requests.start(chatId, 'first')
    fixture.statuses.mockImplementation(async (ids: string[]) =>
      ids.map((requestId) => ({
        requestId,
        result: { status: 'SAVED' as const, chatId, messageId, sequence: '7' },
      })),
    )
    await vi.advanceTimersByTimeAsync(10000)
    expect(resolved).toHaveBeenCalledOnce()
    expect(resolved.mock.calls[0][0]).toEqual([expect.objectContaining({ chatId })])
  })

  it('offers Try again after bounded status outages without publishing a later chat', async () => {
    vi.useFakeTimers()
    const fixture = setup()
    fixture.adapters.now = Date.now
    fixture.statuses.mockRejectedValue(new TypeError('status unavailable'))
    fixture.requests.start(chatId, 'first')
    fixture.requests.start(resolvedChatId, 'second')
    await vi.advanceTimersByTimeAsync(60000)
    expect(fixture.requests.list()[0].status).toBe('retryable')
    expect(fixture.sent.map((send) => send.body)).toEqual(['first'])
  })

  it('holds unknown publication ahead of another chat and retries queued UNKNOWN after reconnect', async () => {
    vi.useFakeTimers()
    const fixture = setup()
    fixture.adapters.now = Date.now
    fixture.requests.start(chatId, 'first')
    fixture.requests.start(resolvedChatId, 'second')
    fixture.requests.unknown(id(1))
    await vi.advanceTimersByTimeAsync(10000)
    expect(fixture.sent.map((send) => send.body)).toEqual(['first', 'first'])
    fixture.requests.queued(id(1))
    fixture.requests.disconnected()
    await fixture.requests.reconcile(true)
    expect(fixture.sent.at(-1)?.requestId).toBe(id(1))
    fixture.requests.saved(id(1), chatId, messageId)
    await vi.advanceTimersByTimeAsync(75)
    expect(fixture.sent.at(-1)?.body).toBe('second')
  })

  it('unblocks other chats when an active send is forgotten', async () => {
    vi.useFakeTimers()
    const fixture = setup()
    fixture.adapters.now = Date.now
    fixture.requests.start(chatId, 'removed')
    fixture.requests.start(resolvedChatId, 'retained')
    fixture.requests.forget(chatId)
    await vi.advanceTimersByTimeAsync(75)
    expect(fixture.sent.map((send) => send.body)).toEqual(['removed', 'retained'])
  })

  it('waits for SQL save before publishing the next intent even after queue confirmation', async () => {
    vi.useFakeTimers()
    const fixture = setup()
    fixture.adapters.now = Date.now
    fixture.requests.start(chatId, 'first')
    fixture.requests.start(chatId, 'second')
    fixture.requests.queued(id(1))
    await vi.advanceTimersByTimeAsync(1000)
    expect(fixture.sent.map((send) => send.body)).toEqual(['first'])
    fixture.requests.saved(id(1), chatId, messageId)
    expect(fixture.sent.map((send) => send.body)).toEqual(['first', 'second'])
  })

  it('paces 200 immediate intents in order and keeps transient retries pending with the same ID', async () => {
    vi.useFakeTimers()
    const fixture = setup()
    fixture.adapters.now = Date.now
    fixture.adapters.send = (send) => {
      fixture.sent.push(send)
      if (fixture.sent.length === 1) fixture.requests.transient(send.requestId)
      else fixture.requests.saved(send.requestId, chatId, messageId)
    }
    for (let index = 0; index < 200; index++)
      expect(fixture.requests.start(chatId, String(index))).toEqual({ ok: true })
    expect(fixture.sent).toHaveLength(1)
    expect(fixture.requests.list().every((send) => send.status === 'sending')).toBe(true)
    await vi.advanceTimersByTimeAsync(20000)
    expect(fixture.sent.map((send) => send.body)).toEqual([
      '0',
      ...Array.from({ length: 200 }, (_, i) => String(i)),
    ])
    expect(new Set(fixture.sent.map((send) => send.requestId)).size).toBe(200)
    expect(fixture.requests.list().every((send) => send.status === 'saved')).toBe(true)
  })

  it('retains unsent intents through disconnect and reload without showing a failure at capacity', async () => {
    vi.useFakeTimers()
    const fixture = setup()
    fixture.disconnect()
    for (let index = 0; index < 256; index++)
      expect(fixture.requests.start(chatId, 'waiting')).toEqual({ ok: true })
    expect(fixture.requests.start(chatId, 'keep in composer')).toEqual({ ok: false })
    expect(fixture.sent).toEqual([])
    const reloaded = new SendRequests('relay.user.device', fixture.adapters)
    fixture.adapters.now = Date.now
    fixture.adapters.send = (send) => {
      fixture.sent.push(send)
      reloaded.saved(send.requestId, chatId, messageId)
    }
    fixture.connect()
    await reloaded.reconcile(true)
    await vi.advanceTimersByTimeAsync(20000)
    expect(fixture.sent).toHaveLength(256)
    expect(fixture.sent.map((send) => send.requestId)).toEqual(
      Array.from({ length: 256 }, (_, index) => id(index + 1)),
    )
    expect(reloaded.list().every((send) => send.status === 'saved')).toBe(true)
  })

  it('retains reply identity and request fingerprint through storage and unknown retries, then removes deleted-chat intents', async () => {
    const fixture = setup()
    fixture.requests.start(chatId, 'A reply', messageId)
    const original = fixture.sent[0]
    const reloaded = new SendRequests('relay.user.device', fixture.adapters)
    await reloaded.reconcile(true)
    expect(fixture.sent[1]).toMatchObject({
      requestId: original.requestId,
      body: 'A reply',
      replyToMessageId: messageId,
    })
    reloaded.forget(chatId)
    await reloaded.reconcile(true)
    expect(fixture.sent).toHaveLength(2)
    expect(reloaded.list()).toEqual([])
    expect(fixture.values.get('relay.user.device.pending')).toBe('[]')
  })

  it('counts message limits in Unicode codepoints', () => {
    const fixture = setup()
    expect(fixture.requests.start(chatId, '😀'.repeat(4000))).toEqual({ ok: true })
    expect(fixture.sent[0].body).toBe('😀'.repeat(4000))
    expect(fixture.requests.start(chatId, '😀'.repeat(4001))).toEqual({ ok: false })
  })

  it('discards malformed stored requests and deduplicates retries without losing valid work', async () => {
    const test = setup()
    const valid = pending(id(1000), 'retryable')
    test.values.set(
      'relay.user.device.pending',
      JSON.stringify([
        null,
        'invalid',
        {},
        { ...valid, status: 'unexpected' },
        { ...valid, requestId: 'bad-id' },
        { ...valid, requestId: id(1001), body: {} },
        { ...valid, requestId: id(1004), chatId: 'bad-id' },
        { ...valid, requestId: id(1005), messageId: 'bad-id' },
        { ...valid, requestId: id(1006), chatId: 'draft:bad-id', recipientId: 'bad-id' },
        { ...valid, requestId: id(1002), createdAt: 'not a date' },
        { ...valid, requestId: id(1003), chatId: draftChatId, recipientId: id(10007) },
        valid,
        valid,
      ]),
    )
    const requests = new SendRequests('relay.user.device', test.adapters)
    test.statuses.mockImplementation(async (requestIds) => {
      if (requestIds.includes('bad-id')) throw new Error('Invalid request IDs')
      return requestIds.map((requestId) => ({ requestId, result: { status: 'UNKNOWN' } }))
    })
    expect(requests.list()).toEqual([valid])
    await requests.reconcile(true)
    expect(test.statuses).toHaveBeenCalledWith([id(1000)])
    expect(test.sent.map((send) => send.requestId)).toEqual([id(1000)])
  })

  it('persists a request before sending and keeps saved after a late queued frame', () => {
    const fixture = setup()
    const send = vi.fn((item: PendingSend) => {
      expect(JSON.parse(fixture.values.get('relay.user.device.pending') || '[]')).toEqual([item])
    })
    const requests = new SendRequests('relay.user.device', {
      storage: {
        getItem: (key) => fixture.values.get(key) ?? null,
        setItem: (key, value) => {
          fixture.values.set(key, value)
        },
      },
      statuses: fixture.statuses,
      status: fixture.status,
      send,
      isConnected: () => true,
      createId: () => id(1),
      now: () => Date.parse('2026-09-28T10:00:00Z'),
      onChange: () => {},
    })
    expect(requests.start(chatId, ' Hello ')).toEqual({ ok: true })
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ requestId: id(1), body: 'Hello' }))
    expect(requests.saved(id(1), chatId, messageId)).toEqual({ chatId: chatId })
    requests.queued(id(1))
    expect(requests.list()).toEqual([
      expect.objectContaining({ requestId: id(1), messageId, status: 'saved' }),
    ])
    expect(JSON.parse(fixture.values.get('relay.user.device.pending') || '[]')).toEqual([])
  })

  it('checks status before a manual unknown retry and reuses the request ID', async () => {
    const fixture = setup([pending(id(7), 'retryable')])
    fixture.status.mockResolvedValue({ status: 'UNKNOWN' })
    await fixture.requests.retry(id(7))
    expect(fixture.status).toHaveBeenCalledWith(id(7))
    expect(fixture.sent).toEqual([expect.objectContaining({ requestId: id(7), body: 'Hello' })])
    expect(fixture.requests.list()[0]).toEqual(
      expect.objectContaining({ requestId: id(7), status: 'sending' }),
    )
  })

  it('checks unresolved requests in batches of 100 and resolves saved statuses', async () => {
    const fixture = setup(Array.from({ length: 101 }, (_, index) => pending(id(index))))
    fixture.statuses.mockImplementation(async (requestIds) =>
      requestIds.map((requestId) => ({
        requestId,
        result: { status: 'SAVED' as const, chatId: chatId, messageId: messageId },
      })),
    )
    const outcomes = await fixture.requests.reconcile()
    expect(fixture.statuses.mock.calls.map(([requestIds]) => requestIds.length)).toEqual([100, 1])
    expect(outcomes).toHaveLength(101)
    expect(fixture.requests.list()).toHaveLength(101)
    expect(fixture.requests.list().every((send) => send.status === 'saved')).toBe(true)
    expect(JSON.parse(fixture.values.get('relay.user.device.pending') || '[]')).toEqual([])
  })

  it('ignores duplicate status and frame results', async () => {
    const fixture = setup([pending(id(1))])
    fixture.statuses.mockResolvedValue([
      { requestId: id(1), result: { status: 'SAVED', chatId: chatId, messageId: messageId } },
    ])
    expect(await fixture.requests.reconcile()).toEqual([{ chatId: chatId }])
    expect(fixture.requests.saved(id(1), chatId, messageId)).toBeUndefined()
    fixture.requests.queued(id(1))
    expect(await fixture.requests.reconcile()).toEqual([])
    expect(fixture.changes).toHaveLength(1)
  })

  it('reports direct draft resolution from a saved frame and status lookup', async () => {
    const first = setup([{ ...pending(id(1), 'sending', draftChatId), recipientId: recipientId }])
    expect(first.requests.saved(id(1), resolvedChatId, messageId)).toEqual({
      chatId: resolvedChatId,
      draftChatId: draftChatId,
    })
    const second = setup([
      { ...pending(id(2), 'retryable', draftChatId), recipientId: recipientId },
    ])
    second.status.mockResolvedValue({
      status: 'SAVED',
      chatId: resolvedChatId,
      messageId: messageId,
    })
    expect(await second.requests.retry(id(2))).toEqual({
      chatId: resolvedChatId,
      draftChatId: draftChatId,
    })
  })

  it('keeps rejected UI and stored states lowercase after an uppercase lookup result', async () => {
    const fixture = setup([pending(id(1))])
    fixture.statuses.mockResolvedValue([
      { requestId: id(1), result: { status: 'REJECTED', reason: 'NOT_A_MEMBER' } },
    ])
    await fixture.requests.reconcile()
    expect(fixture.requests.list()[0]).toMatchObject({
      status: 'rejected',
      reason: 'NOT_A_MEMBER',
    })
    expect(JSON.parse(fixture.values.get('relay.user.device.pending') || '[]')[0].status).toBe(
      'rejected',
    )
  })

  it('retries a queued request with the same ID after reconnect', async () => {
    const fixture = setup([pending(id(1), 'queued')])
    await fixture.requests.reconcile(true)
    expect(fixture.sent.map((send) => send.requestId)).toEqual([id(1)])
    expect(fixture.requests.list()[0].status).toBe('sending')
  })

  it('keeps reconnect retry intent when a status poll is already in flight', async () => {
    const fixture = setup([pending(id(1))])
    let resolveStatus!: (value: { requestId: string; result: SendResult }[]) => void
    fixture.statuses.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve
        }),
    )
    const inFlight = fixture.requests.reconcile()
    expect(await fixture.requests.reconcile(true)).toEqual([])
    resolveStatus([{ requestId: id(1), result: { status: 'UNKNOWN' } }])
    await inFlight
    expect(fixture.sent).toEqual([])
    await fixture.requests.reconcile()
    expect(fixture.sent).toEqual([expect.objectContaining({ requestId: id(1) })])
  })

  it('keeps reconnect retry intent through status backoff', async () => {
    const fixture = setup([pending(id(1))])
    fixture.statuses.mockRejectedValueOnce(new Error('Status unavailable'))
    await fixture.requests.reconcile()
    await fixture.requests.reconcile(true)
    fixture.advanceTime(30000)
    await fixture.requests.reconcile()
    expect(fixture.sent).toEqual([expect.objectContaining({ requestId: id(1) })])
  })

  it('keeps retry intent when the socket disconnects before every resend', async () => {
    vi.useFakeTimers()
    const fixture = setup([pending(id(1)), pending(id(2))])
    fixture.adapters.now = Date.now
    fixture.adapters.send = (send) => {
      fixture.sent.push(send)
      fixture.disconnect()
    }
    await fixture.requests.reconcile(true)
    expect(fixture.sent.map((send) => send.requestId)).toEqual([id(1)])
    fixture.connect()
    fixture.adapters.send = (send) => {
      fixture.sent.push(send)
      fixture.requests.saved(send.requestId, chatId, messageId)
    }
    await fixture.requests.reconcile()
    await vi.advanceTimersByTimeAsync(200)
    expect(fixture.sent.map((send) => send.requestId)).toEqual([id(1), id(1), id(2)])
  })
})
