import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatRecovery } from './chatRecovery'
import { baselineStorage, connectedRecovery, memoryStorage, message } from './chatRecovery.fixtures'
import type { Message } from './model'

describe('ChatRecovery live', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces contiguous live acknowledgements within a bounded interval', async () => {
    vi.useFakeTimers()
    const { recovery, frames } = connectedRecovery({
      latest: async () => ({ messages: [] }),
      after: async () => ({ messages: [], hasMore: false, nextSequence: '0' }),
      older: async () => ({ messages: [] }),
    })

    await recovery.onLive(message('1'), 'group:chat', () => true, 'epoch', '1-0')
    await recovery.onLive(message('2'), 'group:chat', () => true, 'epoch', '2-0')
    await recovery.onLive(message('3'), 'group:chat', () => true, 'epoch', '3-0')
    expect(frames).toEqual([])
    await vi.advanceTimersByTimeAsync(25)
    expect(frames).toEqual([
      {
        type: 'applied',
        version: 1,
        chatId: 'chat',
        sequence: '3',
        epoch: 'epoch',
        streamId: '3-0',
      },
    ])
  })

  it('clears a large live burst before it can exhaust the pending acknowledgement limit', async () => {
    vi.useFakeTimers()
    const { recovery, frames } = connectedRecovery({
      latest: async () => ({ messages: [] }),
      after: async () => ({ messages: [], hasMore: false, nextSequence: '0' }),
      older: async () => ({ messages: [] }),
    })

    for (let sequence = 1; sequence <= 64; sequence += 1) {
      await recovery.onLive(message(String(sequence)), 'group:chat', () => true)
    }

    expect(frames).toEqual([{ type: 'applied', version: 1, chatId: 'chat', sequence: '64' }])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('persists and renders a live burst once while advancing its baseline immediately', async () => {
    vi.useFakeTimers()
    const storage = memoryStorage()
    const persist = vi.spyOn(storage, 'setItem')
    const { recovery, changes } = connectedRecovery(
      {
        latest: async () => ({ messages: [] }),
        after: async () => ({ messages: [], hasMore: false, nextSequence: '0' }),
        older: async () => ({ messages: [] }),
      },
      storage,
    )

    await recovery.onLive(message('1'), 'group:chat', () => true, 'epoch', '1-0')
    await recovery.onLive(message('2'), 'group:chat', () => true, 'epoch', '2-0')
    await recovery.onLive(message('3'), 'group:chat', () => true, 'epoch', '3-0')
    expect(recovery.baseline('chat')).toBe('3')
    expect(changes()).toBe(0)
    expect(persist).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(25)
    expect(changes()).toBe(1)
    expect(persist).toHaveBeenCalledTimes(2)
    expect(storage.getItem('device.resolved-cursor.v2')).toBe('{"chat":"3"}')
    expect(storage.getItem('device.room-cursor.v2')).toBe(
      '{"group:chat":{"epoch":"epoch","streamId":"3-0"}}',
    )
  })

  it('restarts from conservative persisted progress when interrupted before a live flush', async () => {
    vi.useFakeTimers()
    const storage = memoryStorage()
    const { recovery, frames } = connectedRecovery(
      {
        latest: async () => ({ messages: [] }),
        after: async () => ({ messages: [], hasMore: false, nextSequence: '0' }),
        older: async () => ({ messages: [] }),
      },
      storage,
    )

    await recovery.onLive(message('1'), 'group:chat', () => true, 'epoch', '1-0')
    const restarted = new ChatRecovery('device', storage)

    expect(recovery.baseline('chat')).toBe('1')
    expect(restarted.baseline('chat')).toBe('0')
    expect(frames).toEqual([])
    recovery.dispose()
  })

  it('keeps the newest replay cursor when duplicate live messages arrive out of order', async () => {
    vi.useFakeTimers()
    const { recovery, frames } = connectedRecovery({
      latest: async () => ({ messages: [] }),
      after: async () => ({ messages: [], hasMore: false, nextSequence: '0' }),
      older: async () => ({ messages: [] }),
    })

    await recovery.onLive(message('1'), 'group:chat', () => true, 'epoch', '1-0')
    await recovery.onLive(message('2'), 'group:chat', () => true, 'epoch', '2-0')
    await recovery.onLive(message('1'), 'group:chat', () => true, 'epoch', '1-0')
    await vi.advanceTimersByTimeAsync(25)

    expect(frames).toEqual([
      {
        type: 'applied',
        version: 1,
        chatId: 'chat',
        sequence: '2',
        epoch: 'epoch',
        streamId: '2-0',
      },
    ])
  })

  it('applies a contiguous live message without a separate receipt', async () => {
    const { recovery, frames } = connectedRecovery({
      latest: async () => ({ messages: [] }),
      after: async () => ({ messages: [], hasMore: false, nextSequence: '0' }),
      older: async () => ({ messages: [] }),
    })

    await recovery.onLive(message('1'), 'group:chat', () => true, 'epoch', '1-0')

    await vi.waitFor(() => expect(frames).toHaveLength(1))
    expect(frames).toEqual([
      {
        type: 'applied',
        version: 1,
        chatId: 'chat',
        sequence: '1',
        epoch: 'epoch',
        streamId: '1-0',
      },
    ])
  })

  it('keeps a recovery baseline when storage is blocked', async () => {
    const blocked: Pick<Storage, 'getItem' | 'setItem'> = {
      getItem: () => {
        throw new Error('storage blocked')
      },
      setItem: () => {
        throw new Error('storage blocked')
      },
    }
    const { recovery, frames } = connectedRecovery(
      {
        latest: async () => ({ messages: [] }),
        after: async () => ({ messages: [], hasMore: false, nextSequence: '0' }),
        older: async () => ({ messages: [] }),
      },
      blocked,
    )

    await recovery.onLive(message('1'), 'group:chat', () => true)

    expect(recovery.baseline('chat')).toBe('1')
    await vi.waitFor(() => expect(frames).toHaveLength(1))
    expect(frames).toEqual([{ type: 'applied', version: 1, chatId: 'chat', sequence: '1' }])
  })

  it('receives a live message immediately and applies it only after SQL fills the gap', async () => {
    let releaseHistory:
      ((value: { messages: Message[]; hasMore: boolean; nextSequence: string }) => void) | undefined
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

    const handling = recovery.onLive(message('3'), 'group:chat', () => true, 'epoch', '30-0')
    expect(frames).toEqual([
      { type: 'received_message', version: 1, chatId: 'chat', sequence: '3' },
    ])

    releaseHistory!({ messages: [message('2'), message('3')], hasMore: false, nextSequence: '3' })
    await handling
    await vi.waitFor(() => expect(frames).toHaveLength(3))
    expect(frames).toEqual([
      { type: 'received_message', version: 1, chatId: 'chat', sequence: '3' },
      { type: 'applied', version: 1, chatId: 'chat', sequence: '3' },
      {
        type: 'applied',
        version: 1,
        chatId: 'chat',
        sequence: '3',
        epoch: 'epoch',
        streamId: '30-0',
      },
    ])
    recovery.onSocketOpened('chat')
    expect(frames.at(-1)).toEqual({
      type: 'subscribe_many',
      version: 1,
      subscriptions: [
        {
          chatId: 'chat',
          kind: 'GROUP',
          lastAppliedSequence: '3',
          epoch: 'epoch',
          streamId: '30-0',
        },
      ],
    })
  })
})

it('reads history again after a recovery hint that arrives during an older catch-up', async () => {
  let release!: () => void
  const inFlight = new Promise<void>((resolve) => {
    release = resolve
  })
  const after = vi
    .fn()
    .mockImplementationOnce(async () => {
      await inFlight
      return { messages: [], hasMore: false, nextSequence: '1' }
    })
    .mockResolvedValue({ messages: [message('2')], hasMore: false, nextSequence: '2' })
  const { recovery } = connectedRecovery(
    {
      after,
      latest: async () => ({ messages: [message('1')] }),
      older: async () => ({ messages: [] }),
    },
    baselineStorage('1'),
  )
  const opening = recovery.catchUp('chat')
  await vi.waitFor(() => expect(after).toHaveBeenCalledTimes(1))
  const hints = [
    recovery.catchUp('chat', false, '0', false, true),
    recovery.catchUp('chat', false, '0', false, true),
  ]
  release()
  await Promise.all([opening, ...hints])
  expect(recovery.baseline('chat')).toBe('2')
  expect(after).toHaveBeenCalledTimes(2)
  recovery.dispose()
})
