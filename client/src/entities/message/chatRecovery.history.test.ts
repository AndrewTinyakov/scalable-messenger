import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatRecovery, type RecoveryHistory } from './chatRecovery'
import { baselineStorage, connectedRecovery, message } from './chatRecovery.fixtures'
import type { Message } from './model'

describe('ChatRecovery history', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([false, true])(
    'offers newer history after live arrivals while scrolled up, summary first: %s',
    async (summaryFirst) => {
      const recovery = new ChatRecovery('history-reader', baselineStorage('1'))
      let readingHistory = false
      const snapshot = (end: string) => ({
        snapshotSequence: end,
        coverageAfterSequence: '0',
        coverageThroughSequence: end,
        mutationRevision: '0',
        visibilityRevision: '0',
        clearedThroughSequence: '0',
        globalClearedThroughSequence: '0',
      })
      recovery.configure({
        history: {
          latest: async () => ({ ...snapshot('1'), messages: [message('1')], hasMore: false }),
          after: async () => ({
            ...snapshot('4'),
            coverageAfterSequence: '1',
            messages: ['2', '3', '4'].map(message),
            hasMore: false,
            nextSequence: '4',
          }),
          older: async () => ({ messages: [] }),
        },
        context: () => ({
          selected: true,
          readingHistory,
          removed: false,
          connected: true,
          room: 'group:chat',
          kind: 'GROUP',
        }),
        changed: () => {},
        sendFrame: () => {},
        jumped: () => {},
        failed: () => {},
        recovered: () => {},
      })
      await recovery.showLatest('chat')
      expect(recovery.availability('chat').hasNewerMessages).toBe(false)
      readingHistory = true
      if (summaryFirst) {
        recovery.recordLatest('chat', '4')
        expect(recovery.availability('chat').hasNewerMessages).toBe(true)
        expect(recovery.baseline('chat')).toBe('1')
      }
      for (const sequence of ['2', '3', '4'])
        await recovery.onLive(message(sequence), 'group:chat', () => true)
      expect(recovery.visibleWindows().chat.map((row) => row.sequence)).toEqual(['1'])
      expect(recovery.availability('chat').hasNewerMessages).toBe(true)
      await recovery.loadNewer('chat')
      expect(recovery.visibleWindows().chat.map((row) => row.sequence)).toEqual([
        '1',
        '2',
        '3',
        '4',
      ])
      expect(recovery.availability('chat').hasNewerMessages).toBe(false)
      recovery.dispose()
    },
  )

  it('keeps a live window attached through 80 own sends followed by 300 peer arrivals', async () => {
    const after = vi.fn(async () => ({ messages: [], hasMore: false, nextSequence: '1' }))
    const older = vi.fn(async () => ({ messages: [] }))
    const { recovery } = connectedRecovery({
      latest: async () => ({
        messages: [message('1')],
        hasMore: false,
        snapshotSequence: '1',
        coverageAfterSequence: '0',
        coverageThroughSequence: '1',
        mutationRevision: '0',
        visibilityRevision: '0',
        clearedThroughSequence: '0',
        globalClearedThroughSequence: '0',
      }),
      after,
      older,
    })
    await recovery.showLatest('chat')
    for (let n = 2; n <= 381; n++) {
      recovery.recordLatest('chat', String(n))
      expect(recovery.availability('chat').hasNewerMessages).toBe(false)
      await recovery.onLive(
        { ...message(String(n)), senderId: n <= 81 ? 'me' : 'peer' },
        'group:chat',
        () => true,
      )
      expect(recovery.availability('chat').hasNewerMessages).toBe(false)
    }
    expect(recovery.visibleWindows().chat.map((row) => row.sequence)).toEqual(
      Array.from({ length: 200 }, (_, i) => String(i + 182)),
    )
    expect(recovery.availability('chat').hasOlderMessages).toBe(true)
    expect(after).not.toHaveBeenCalled()
    expect(older).not.toHaveBeenCalled()
    recovery.dispose()
  })

  it('lets a live arrival satisfy a slightly newer visibility snapshot before fetching history', async () => {
    const metadata = {
      snapshotSequence: '1',
      mutationRevision: '0',
      visibilityRevision: '0',
      clearedThroughSequence: '0',
      globalClearedThroughSequence: '0',
    }
    const after = vi.fn(async () => ({
      messages: [message('2')],
      hasMore: false,
      nextSequence: '2',
    }))
    const { recovery } = connectedRecovery({
      latest: async () => ({
        ...metadata,
        messages: [message('1')],
        hasMore: false,
        coverageAfterSequence: '0',
        coverageThroughSequence: '1',
      }),
      older: async () => ({ messages: [] }),
      after,
      visibility: async () => ({ ...metadata, snapshotSequence: '2', hidden: false }),
      resolve: async () => ({ ...metadata, messages: [] }),
    })
    await recovery.showLatest('chat')
    const syncing = recovery.synchronize('chat')
    await new Promise((resolve) => setTimeout(resolve, 10))
    recovery.applyChanges('chat', [], { ...metadata, snapshotSequence: '2' })
    await recovery.onLive(message('2'), 'group:chat', () => true)
    await syncing
    expect(after).not.toHaveBeenCalled()
    expect(recovery.visibleWindows().chat.at(-1)?.sequence).toBe('2')
    recovery.dispose()
  })

  it('coalesces a saturated 60-frame live burst and recovers its final message after capacity returns', async () => {
    const metadata = {
      snapshotSequence: '1',
      mutationRevision: '0',
      visibilityRevision: '0',
      clearedThroughSequence: '0',
      globalClearedThroughSequence: '0',
    }
    const releases: (() => void)[] = []
    const resolve = vi.fn(
      (_chatId: string, ids: string[]) =>
        new Promise<{ messages: Message[] } & typeof metadata>((release) => {
          releases.push(() =>
            release({
              ...metadata,
              snapshotSequence: '61',
              messages: ids.map((id) => message(id.replace('message-', ''))),
            }),
          )
        }),
    )
    const after = vi.fn(async () => ({
      ...metadata,
      snapshotSequence: '61',
      messages: Array.from({ length: 60 }, (_, i) => message(String(i + 2))),
      coverageAfterSequence: '1',
      coverageThroughSequence: '61',
      nextSequence: '61',
      hasMore: false,
    }))
    const { recovery } = connectedRecovery({
      latest: async () => ({
        ...metadata,
        messages: [message('1')],
        coverageAfterSequence: '0',
        coverageThroughSequence: '1',
        hasMore: false,
      }),
      older: async () => ({ messages: [] }),
      after,
      resolve,
    })
    await recovery.showLatest('chat')
    recovery.observe('chat', { snapshotSequence: '61' })
    const arrivals = Array.from({ length: 60 }, (_, i) =>
      recovery.onLive(message(String(i + 2)), 'group:chat', () => true),
    )
    expect(resolve).toHaveBeenCalledTimes(16)
    expect(after).not.toHaveBeenCalled()
    releases.forEach((release) => release())
    await Promise.all(arrivals)
    expect(after).toHaveBeenCalledTimes(1)
    expect(recovery.baseline('chat')).toBe('61')
    expect(recovery.visibleWindows().chat.map((row) => row.sequence)).toEqual(
      Array.from({ length: 61 }, (_, i) => String(i + 1)),
    )
    recovery.dispose()
  })

  it('orders a bounded out-of-order live burst without paging or detaching the latest window', async () => {
    vi.useFakeTimers()
    const after = vi.fn(async () => ({ messages: [], hasMore: false, nextSequence: '1' }))
    const { recovery } = connectedRecovery({
      latest: async () => ({ messages: [message('1')], hasMore: false }),
      older: async () => ({ messages: [] }),
      after,
    })
    await recovery.showLatest('chat')
    const arrivals = ['5', '2', '4', '3'].map((sequence) =>
      recovery.onLive(message(sequence), 'group:chat', () => true),
    )
    expect(recovery.baseline('chat')).toBe('5')
    expect(recovery.visibleWindows().chat.map((row) => row.sequence)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
    ])
    await vi.advanceTimersByTimeAsync(1250)
    await Promise.all(arrivals)
    expect(after).not.toHaveBeenCalled()
    expect(recovery.availability('chat').hasNewerMessages).toBe(false)
    recovery.dispose()
  })

  it('lets concurrent recovery callers wait for the shared history result', async () => {
    let releaseHistory!: (value: {
      messages: Message[]
      hasMore: boolean
      nextSequence: string
    }) => void
    const { recovery } = connectedRecovery(
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

    const first = recovery.catchUp('chat')
    let secondFinished = false
    const second = recovery.catchUp('chat').then(() => {
      secondFinished = true
    })
    await Promise.resolve()
    expect(secondFinished).toBe(false)
    releaseHistory({ messages: [message('2')], hasMore: false, nextSequence: '2' })
    await Promise.all([first, second])
    expect(recovery.baseline('chat')).toBe('2')
  })

  it('drops a Room replay cursor after jumping over a recovery gap', async () => {
    let latest = [message('1')]
    const { recovery, frames } = connectedRecovery({
      latest: async () => ({ messages: latest }),
      after: async () => ({ messages: [], hasMore: false, nextSequence: '1' }),
      older: async () => ({ messages: [] }),
    })
    await recovery.catchUp('chat', true)
    await recovery.onLive(message('1'), 'group:chat', () => true, 'epoch', '1-0')
    recovery.onSocketOpened('chat')
    expect(frames.at(-1)).toEqual({
      type: 'subscribe_many',
      version: 1,
      subscriptions: [
        {
          chatId: 'chat',
          kind: 'GROUP',
          lastAppliedSequence: '1',
          epoch: 'epoch',
          streamId: '1-0',
        },
      ],
    })

    latest = [message('5')]
    await recovery.showLatest('chat')
    recovery.onSocketOpened('chat')

    expect(frames.at(-1)).toEqual({
      type: 'subscribe_many',
      version: 1,
      subscriptions: [{ chatId: 'chat', kind: 'GROUP', lastAppliedSequence: '5' }],
    })
  })

  it('keeps an older Chat window while live messages arrive, then pages forward', async () => {
    const latest = Array.from({ length: 200 }, (_, index) => message(String(index + 51)))
    const { recovery } = connectedRecovery({
      latest: async () => ({ messages: latest }),
      after: async () => ({
        messages: Array.from({ length: 51 }, (_, index) => message(String(index + 201))),
        hasMore: false,
        nextSequence: '251',
      }),
      older: async () => ({
        messages: Array.from({ length: 50 }, (_, index) => message(String(index + 1))),
      }),
    })
    await recovery.showLatest('chat')
    await recovery.loadOlder('chat')
    expect(recovery.visibleWindows().chat[0].sequence).toBe('1')

    await recovery.onLive(message('251'), 'group:chat', () => true)
    expect(recovery.visibleWindows().chat.at(-1)?.sequence).toBe('200')
    expect(recovery.latestSequences().chat).toBe('251')
    expect(recovery.baseline('chat')).toBe('251')

    await recovery.loadNewer('chat')
    expect(recovery.visibleWindows().chat.at(-1)?.sequence).toBe('251')
    expect(recovery.baseline('chat')).toBe('251')
  })

  it('does not replace a newer live Chat window with an older SQL page', async () => {
    const { recovery } = connectedRecovery({
      latest: async () => ({ messages: [message('1'), message('2')] }),
      after: async () => ({ messages: [], hasMore: false, nextSequence: '2' }),
      older: async () => ({ messages: [] }),
    })
    await recovery.catchUp('chat', true)
    await recovery.onLive(message('3'), 'group:chat', () => true)

    await recovery.showLatest('chat')

    expect(recovery.visibleWindows().chat.map((item) => item.sequence)).toEqual(['1', '2', '3'])
    expect(recovery.baseline('chat')).toBe('3')
  })

  it('opens a chat from SQL history and acknowledges dismissal before application', async () => {
    const history: RecoveryHistory = {
      latest: async () => ({ messages: [message('8'), message('9')] }),
      after: async () => {
        throw new Error('Unexpected catch-up request')
      },
      older: async () => {
        throw new Error('Unexpected older-page request')
      },
    }
    const { recovery, frames, changes } = connectedRecovery(history)

    await recovery.catchUp('chat', true)

    expect(recovery.visibleWindows().chat.map((item) => item.sequence)).toEqual(['8', '9'])
    expect(recovery.baseline('chat')).toBe('9')
    expect(frames).toEqual([
      { type: 'dismissed', version: 1, chatId: 'chat', sequence: '7' },
      { type: 'applied', version: 1, chatId: 'chat', sequence: '9' },
    ])
    expect(changes()).toBe(1)
  })

  it('bounds SQL catch-up to ten pages before fetching the latest page', async () => {
    let afterCalls = 0
    let latestCalls = 0
    const history: RecoveryHistory = {
      latest: async () => {
        latestCalls += 1
        return { messages: [message('600')] }
      },
      after: async (_, sequence) => {
        afterCalls += 1
        const start = Number(sequence) + 1
        return {
          messages: Array.from({ length: 50 }, (_, index) => message(String(start + index))),
          hasMore: true,
          nextSequence: String(start + 49),
        }
      },
      older: async () => ({ messages: [] }),
    }
    const { recovery } = connectedRecovery(history, baselineStorage('1'))

    await recovery.catchUp('chat')

    expect(afterCalls).toBe(10)
    expect(latestCalls).toBe(1)
  })

  it('retries a failed selected-chat catch-up and stops after success', async () => {
    vi.useFakeTimers()
    try {
      let attempts = 0
      const history: RecoveryHistory = {
        latest: async () => ({ messages: [] }),
        after: async () => {
          attempts += 1
          if (attempts === 1) throw new Error('History unavailable')
          return { messages: [message('2')], hasMore: false, nextSequence: '2' }
        },
        older: async () => ({ messages: [] }),
      }
      const { recovery } = connectedRecovery(history, baselineStorage('1'))

      await recovery.catchUp('chat')
      expect(recovery.baseline('chat')).toBe('1')
      await vi.advanceTimersByTimeAsync(1000)
      expect(recovery.baseline('chat')).toBe('2')
      expect(attempts).toBe(2)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
