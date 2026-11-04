import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OutgoingSocketFrame } from '../../shared/api/socket'
import { ChatRecovery, type RecoveryHistory } from './chatRecovery'
import { baselineStorage, connectedRecovery, memoryStorage, message } from './chatRecovery.fixtures'
import type { Message } from './model'

describe('ChatRecovery lifecycle', () => {
  it('reloads visible history when reconnecting with a persisted cursor and an empty window', async () => {
    const { recovery } = connectedRecovery(
      {
        latest: async () => ({ messages: [message('1')] }),
        after: async () => ({ messages: [], hasMore: false, nextSequence: '1' }),
        older: async () => ({ messages: [] }),
      },
      baselineStorage('1'),
    )

    recovery.onSocketOpened('chat')

    await vi.waitFor(() => expect(recovery.visibleWindows().chat).toEqual([message('1')]))
    expect(recovery.baseline('chat')).toBe('1')
    recovery.dispose()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('discards queued live acknowledgements across socket replacement', async () => {
    vi.useFakeTimers()
    const { recovery, frames } = connectedRecovery({
      latest: async () => ({ messages: [] }),
      after: async () => ({ messages: [], hasMore: false, nextSequence: '0' }),
      older: async () => ({ messages: [] }),
    })

    await recovery.onLive(message('1'), 'group:chat', () => true)
    recovery.onSocketClosed()
    recovery.onSocketOpened(null)
    await vi.advanceTimersByTimeAsync(25)

    expect(frames).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('flushes recovery storage on disposal without sending to a replacement socket', async () => {
    vi.useFakeTimers()
    const storage = memoryStorage()
    const { recovery, frames, changes } = connectedRecovery(
      {
        latest: async () => ({ messages: [] }),
        after: async () => ({ messages: [], hasMore: false, nextSequence: '0' }),
        older: async () => ({ messages: [] }),
      },
      storage,
    )

    await recovery.onLive(message('1'), 'group:chat', () => true, 'epoch', '1-0')
    recovery.dispose()
    await vi.advanceTimersByTimeAsync(1000)

    expect(frames).toEqual([])
    expect(changes()).toBe(0)
    expect(storage.getItem('device.resolved-cursor.v2')).toBe('{"chat":"1"}')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores late live messages after disposal', async () => {
    vi.useFakeTimers()
    const { recovery, frames, changes } = connectedRecovery({
      latest: async () => ({ messages: [] }),
      after: async () => ({ messages: [], hasMore: false, nextSequence: '0' }),
      older: async () => ({ messages: [] }),
    })

    recovery.dispose()
    await recovery.onLive(message('1'), 'group:chat', () => true, 'epoch', '1-0')

    expect(recovery.baseline('chat')).toBe('0')
    expect(recovery.visibleWindows()).toEqual({})
    expect(frames).toEqual([])
    expect(changes()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores a history result that arrives after disposal', async () => {
    let releaseHistory!: (value: {
      messages: Message[]
      hasMore: boolean
      nextSequence: string
    }) => void
    const { recovery, frames, changes } = connectedRecovery(
      {
        latest: async () => ({ messages: [] }),
        after: () =>
          new Promise((resolve) => {
            releaseHistory = resolve
          }),
        older: async () => ({ messages: [] }),
      },
      baselineStorage('1'),
    )

    const request = recovery.catchUp('chat')
    recovery.dispose()
    releaseHistory({ messages: [message('2')], hasMore: false, nextSequence: '2' })
    await request

    expect(recovery.baseline('chat')).toBe('1')
    expect(recovery.visibleWindows()).toEqual({})
    expect(frames).toEqual([])
    expect(changes()).toBe(0)
  })

  it('keeps old socket catch-up acknowledgements out of a replacement connection', async () => {
    vi.useFakeTimers()
    let releaseHistory!: (value: {
      messages: Message[]
      hasMore: boolean
      nextSequence: string
    }) => void
    const { recovery, frames } = connectedRecovery(
      {
        latest: async () => ({ messages: [] }),
        after: () =>
          new Promise((resolve) => {
            releaseHistory = resolve
          }),
        older: async () => ({ messages: [] }),
      },
      baselineStorage('1'),
    )

    const handling = recovery.onLive(message('3'), 'group:chat', () => true, 'epoch', '3-0')
    recovery.onSocketClosed()
    recovery.onSocketOpened(null)
    releaseHistory({ messages: [message('2'), message('3')], hasMore: false, nextSequence: '3' })
    await handling
    await vi.advanceTimersByTimeAsync(25)

    expect(recovery.baseline('chat')).toBe('3')
    expect(frames).toEqual([
      { type: 'received_message', version: 1, chatId: 'chat', sequence: '3' },
    ])
  })

  it('falls back to history when persisted positions have invalid shapes or sequences', async () => {
    const storage = memoryStorage()
    storage.setItem(
      'device.resolved-cursor.v2',
      JSON.stringify({ chat: 'invalid', other: '9223372036854775808' }),
    )
    storage.setItem('device.dismissed-through.v2', 'null')
    storage.setItem(
      'device.room-cursor.v2',
      JSON.stringify({ 'group:chat': { epoch: 'epoch', streamId: 'invalid' } }),
    )
    const test = connectedRecovery(
      {
        latest: async () => ({ messages: [message('1')] }),
        after: async () => ({ messages: [], hasMore: false, nextSequence: '0' }),
        older: async () => ({ messages: [] }),
      },
      storage,
    )
    expect(test.recovery.baseline('chat')).toBe('0')
    test.recovery.onSelected('chat')
    await vi.waitFor(() => expect(test.recovery.baseline('chat')).toBe('1'))
    expect(test.frames[0]).toEqual({
      type: 'subscribe_many',
      version: 1,
      subscriptions: [{ chatId: 'chat', kind: 'GROUP', lastAppliedSequence: '0' }],
    })
  })

  it('resends dismissal before subscribing and starts SQL catch-up for the selected Chat', async () => {
    const storage = memoryStorage()
    storage.setItem('device.resolved-cursor.v2', JSON.stringify({ chat: '7' }))
    storage.setItem('device.dismissed-through.v2', JSON.stringify({ chat: '7' }))
    const frames: OutgoingSocketFrame[] = []
    const recovery = new ChatRecovery('device', storage)
    recovery.configure({
      history: {
        latest: async () => ({ messages: [message('8'), message('9')] }),
        after: async () => {
          throw new Error('Unexpected after request')
        },
        older: async () => {
          throw new Error('Unexpected older request')
        },
      },
      context: () => ({
        selected: true,
        readingHistory: false,
        removed: false,
        connected: true,
        room: 'group:chat',
        kind: 'GROUP',
      }),
      changed: () => {},
      sendFrame: (frame) => {
        if (frame) frames.push(frame)
      },
      jumped: () => {},
      failed: () => {},
      recovered: () => {},
    })

    recovery.onSelected('chat')

    await vi.waitFor(() =>
      expect(frames).toEqual([
        { type: 'dismissed', version: 1, chatId: 'chat', sequence: '7' },
        {
          type: 'subscribe_many',
          version: 1,
          subscriptions: [{ chatId: 'chat', kind: 'GROUP', lastAppliedSequence: '7' }],
        },
        { type: 'applied', version: 1, chatId: 'chat', sequence: '9' },
      ]),
    )
  })

  it('reopens the selected Chat after reconnect and subscription expiry', () => {
    const frames: OutgoingSocketFrame[] = []
    const recovery = new ChatRecovery('device', memoryStorage())
    recovery.configure({
      history: {
        latest: async () => ({ messages: [] }),
        after: async () => ({ messages: [], hasMore: false, nextSequence: '0' }),
        older: async () => ({ messages: [] }),
      },
      context: () => ({
        selected: true,
        readingHistory: false,
        removed: false,
        connected: true,
        room: 'group:chat',
        kind: 'GROUP',
      }),
      changed: () => {},
      sendFrame: (frame) => {
        if (frame) frames.push(frame)
      },
      jumped: () => {},
      failed: () => {},
      recovered: () => {},
    })

    recovery.onSocketOpened('chat')
    recovery.onSocketClosed()
    recovery.onSocketOpened('chat')
    recovery.onSubscriptionExpired('chat')

    expect(frames.filter((frame) => frame.type === 'subscribe_many')).toHaveLength(3)
  })

  it('unsubscribes the previous Chat before subscribing to a new selection', () => {
    const frames: OutgoingSocketFrame[] = []
    let selected = 'chat'
    const recovery = new ChatRecovery('device', memoryStorage())
    recovery.configure({
      history: {
        latest: async () => ({ messages: [] }),
        after: async () => ({ messages: [], hasMore: false, nextSequence: '0' }),
        older: async () => ({ messages: [] }),
      },
      context: (chatId) => ({
        selected: chatId === selected,
        readingHistory: false,
        removed: false,
        connected: true,
        room: `group:${chatId}`,
        kind: 'GROUP',
      }),
      changed: () => {},
      sendFrame: (frame) => {
        if (frame) frames.push(frame)
      },
      jumped: () => {},
      failed: () => {},
      recovered: () => {},
    })

    recovery.onSocketOpened('chat')
    selected = 'next-chat'
    recovery.onSelected(selected)

    expect(frames.map((frame) => frame.type)).toEqual([
      'subscribe_many',
      'unsubscribe',
      'subscribe_many',
    ])
    expect(frames[1]).toEqual({ type: 'unsubscribe', version: 1, chatId: 'chat' })
    expect(frames[2]).toEqual({
      type: 'subscribe_many',
      version: 1,
      subscriptions: [{ chatId: 'next-chat', kind: 'GROUP', lastAppliedSequence: '0' }],
    })
  })

  it('restores an explicit dismissal before a later Chat subscription', async () => {
    const storage = memoryStorage()
    const history: RecoveryHistory = {
      latest: async () => ({ messages: [message('8'), message('9')] }),
      after: async () => ({ messages: [], hasMore: false, nextSequence: '9' }),
      older: async () => ({ messages: [] }),
    }
    const first = connectedRecovery(history, storage)
    await first.recovery.catchUp('chat', true)
    const restored = connectedRecovery(history, storage)

    restored.recovery.onSocketOpened('chat')

    expect(restored.frames.slice(0, 2)).toEqual([
      { type: 'dismissed', version: 1, chatId: 'chat', sequence: '7' },
      {
        type: 'subscribe_many',
        version: 1,
        subscriptions: [{ chatId: 'chat', kind: 'GROUP', lastAppliedSequence: '9' }],
      },
    ])
  })

  it('cancels a pending catch-up retry when the socket closes', async () => {
    vi.useFakeTimers()
    try {
      let attempts = 0
      const history: RecoveryHistory = {
        latest: async () => ({ messages: [] }),
        after: async () => {
          attempts += 1
          throw new Error('History unavailable')
        },
        older: async () => ({ messages: [] }),
      }
      const { recovery } = connectedRecovery(history, baselineStorage('1'))

      await recovery.catchUp('chat')
      recovery.onSocketClosed()
      await vi.advanceTimersByTimeAsync(1000)

      expect(attempts).toBe(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
