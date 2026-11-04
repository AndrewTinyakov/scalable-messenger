import { describe, expect, it, vi } from 'vitest'
import { ChatRecovery, type RecoveryRuntime } from './chatRecovery'
import { baselineStorage, connectedRecovery, memoryStorage, message } from './chatRecovery.fixtures'
import type { HistorySnapshot } from './historySnapshot'
import type { Message } from './model'

function snapshot(
  messages: Message[],
  after: string,
  through: string,
  revision = '0',
  visibilityRevision = '0',
): HistorySnapshot & { nextSequence: string; hasMore: boolean } {
  return {
    messages,
    snapshotSequence: through,
    mutationRevision: revision,
    visibilityRevision,
    clearedThroughSequence: '0',
    globalClearedThroughSequence: '0',
    coverageAfterSequence: after,
    coverageThroughSequence: through,
    nextSequence: through,
    hasMore: false,
  }
}

describe('certified visible history', () => {
  it('keeps a newer local edit while a fenced changes request is in flight', async () => {
    const { recovery } = connectedRecovery({
      latest: async () => snapshot([message('1')], '0', '1'),
      after: async () => snapshot([], '1', '1'),
      older: async () => snapshot([], '0', '0'),
    })
    await recovery.catchUp('chat', true)
    const old = {
      changes: [{ revision: '1', message: message('1') }],
      lastRevision: '1',
      nextRevision: '1',
      resetRequired: false,
      visibilityRevision: '0',
    }
    let release!: (value: typeof old) => void
    const loading = recovery.fetchChanges(
      'chat',
      () =>
        new Promise<typeof old>((resolve) => {
          release = resolve
        }),
    )
    recovery.patch('chat', [{ ...message('1'), body: 'new edit', messageVersion: '2' }])
    release(old)
    const page = (await loading)!
    recovery.applyChanges('chat', page.changes, { ...page, mutationRevision: page.lastRevision })
    expect(recovery.visibleWindows().chat[0]).toMatchObject({
      body: 'new edit',
      messageVersion: '2',
    })
    recovery.dispose()
  })
  it('yields a long anchor continuation, resumes its bookmark and cancels pending work on navigation', async () => {
    vi.useFakeTimers()
    const restored = vi.fn()
    const after = vi.fn(async (_chat: string, cursor: string) =>
      Number(cursor) < 144
        ? {
            ...snapshot([], cursor, String(Number(cursor) + 16)),
            snapshotSequence: '1000',
            hasMore: true,
          }
        : snapshot([message('161')], cursor, '1000'),
    )
    const recovery = new ChatRecovery('device', memoryStorage())
    recovery.configure({
      history: {
        latest: async () => snapshot([message('1000')], '999', '1000'),
        after,
        older: async () => snapshot([], '0', '0'),
        around: async () => ({
          ...snapshot([], '0', '16'),
          snapshotSequence: '1000',
          anchorMessageId: null,
          hasOlder: false,
          hasNewer: true,
        }),
      },
      context: () => ({
        selected: true,
        connected: true,
        readingHistory: false,
        removed: false,
        room: 'group:chat',
        kind: 'GROUP',
      }),
      changed: () => {},
      sendFrame: () => {},
      jumped: () => {},
      failed: () => {},
      recovered: () => {},
      locationRestored: restored,
    })
    try {
      await recovery.catchUp('chat', true)
      recovery.rememberLocation('chat', {
        messageId: 'message-1',
        sequence: '1',
        offsetPx: -17,
        atLatest: false,
      })
      recovery.onSelected('chat')
      await vi.advanceTimersByTimeAsync(0)
      expect(after).toHaveBeenCalledTimes(8)
      expect(recovery.readingLocation('chat')).toMatchObject({
        messageId: 'message-1',
        offsetPx: -17,
      })
      expect(restored).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(50)
      expect(after).toHaveBeenCalledTimes(9)
      expect(restored).toHaveBeenCalledWith('chat', {
        messageId: 'message-161',
        sequence: '161',
        offsetPx: -17,
        atLatest: false,
      })
      after.mockImplementation(async (_chat: string, cursor: string) => ({
        ...snapshot([], cursor, String(Number(cursor) + 16)),
        snapshotSequence: '1000',
        hasMore: true,
      }))
      recovery.rememberLocation('chat', {
        messageId: 'message-1',
        sequence: '1',
        offsetPx: -17,
        atLatest: false,
      })
      restored.mockClear()
      recovery.onSelected(null)
      recovery.onSelected('chat')
      await vi.advanceTimersByTimeAsync(0)
      expect(after).toHaveBeenCalledTimes(17)
      recovery.onSelected(null)
      await vi.advanceTimersByTimeAsync(100)
      expect(after).toHaveBeenCalledTimes(17)
      expect(restored).not.toHaveBeenCalled()
    } finally {
      recovery.dispose()
      vi.useRealTimers()
    }
  })
  it('continues a span-limited empty around search and restores the first survivor at the saved offset', async () => {
    const restored = vi.fn()
    const around = vi.fn(async () => ({
      ...snapshot([], '0', '16'),
      snapshotSequence: '1000',
      anchorMessageId: null,
      hasOlder: false,
      hasNewer: true,
    }))
    const after = vi.fn(async (_chat: string, cursor: string) =>
      cursor === '16'
        ? { ...snapshot([], '16', '32'), snapshotSequence: '1000', hasMore: true }
        : {
            ...snapshot(
              Array.from({ length: 50 }, (_, index) => message(String(41 + index))),
              '32',
              '90',
            ),
            snapshotSequence: '1000',
            hasMore: true,
          },
    )
    const recovery = new ChatRecovery('device', memoryStorage())
    recovery.configure({
      history: {
        latest: async () => snapshot([message('1000')], '999', '1000'),
        after,
        older: async () => snapshot([], '0', '0'),
        around,
      },
      context: () => ({
        selected: true,
        connected: true,
        readingHistory: false,
        removed: false,
        room: 'group:chat',
        kind: 'GROUP',
      }),
      changed: () => {},
      sendFrame: () => {},
      jumped: () => {},
      failed: () => {},
      recovered: () => {},
      locationRestored: restored,
    })
    await recovery.catchUp('chat', true)
    recovery.rememberLocation('chat', {
      messageId: 'message-1',
      sequence: '1',
      offsetPx: -17,
      atLatest: false,
    })
    recovery.onSelected('chat')
    await vi.waitFor(() =>
      expect(restored).toHaveBeenCalledWith('chat', {
        messageId: 'message-41',
        sequence: '41',
        offsetPx: -17,
        atLatest: false,
      }),
    )
    expect(after.mock.calls).toEqual([
      ['chat', '16'],
      ['chat', '32'],
    ])
    expect(recovery.visibleWindows().chat[0].sequence).toBe('41')
    expect(recovery.latestWindows().chat.at(-1)?.sequence).toBe('1000')
    recovery.dispose()
  })
  it('evicts inactive bodies and visibility together without discarding active verification', async () => {
    const metadata = {
      snapshotSequence: '100',
      mutationRevision: '1',
      visibilityRevision: '1',
      clearedThroughSequence: '0',
      globalClearedThroughSequence: '0',
    }
    const latest = vi.fn(async (id: string) => ({
      ...snapshot([{ ...message('100'), id: `${id}-100`, chatId: id }], '0', '100', '1', '1'),
    }))
    const recovery = new ChatRecovery('device', memoryStorage())
    recovery.configure({
      history: {
        latest,
        after: async () => snapshot([], '100', '100', '1', '1'),
        older: async () => snapshot([], '0', '0'),
        visibility: async () => ({ ...metadata, hidden: false }),
        resolve: async () => ({ ...metadata, messages: [] }),
      },
      context: (id) => ({
        selected: id === 'chat',
        connected: true,
        readingHistory: false,
        removed: false,
        room: 'user:alice',
        kind: 'DIRECT',
      }),
      changed: () => {},
      sendFrame: () => {},
      jumped: () => {},
      failed: () => {},
      recovered: () => {},
    })
    recovery.onSelected('chat')
    await recovery.catchUp('chat', true)
    for (let index = 0; index < 250; index += 1) {
      const id = `other-${index}`
      await recovery.synchronize(id)
      recovery.observe(id, { visibilityRevision: '2' })
    }
    expect(Object.keys(recovery.visibleWindows()).length).toBeLessThanOrEqual(101)
    expect(recovery.visibleWindows()['other-0']).toBeUndefined()
    expect(recovery.revisionKey('other-0')).toBe('0:0')
    expect(recovery.visibleWindows()['other-249'][0].id).toBe('other-249-100')
    expect(recovery.latestWindows().chat[0].id).toBe('chat-100')
    const before = latest.mock.calls.filter(([id]) => id === 'chat').length
    await recovery.synchronize('chat')
    expect(latest.mock.calls.filter(([id]) => id === 'chat')).toHaveLength(before)
    recovery.dispose()
  })
  it('bounds many-chat visibility state while preserving the selected chat cutoff', async () => {
    const { recovery } = connectedRecovery({
      latest: async () => snapshot([message('1')], '0', '1'),
      after: async () => snapshot([], '1', '1'),
      older: async () => snapshot([], '0', '0'),
    })
    recovery.onSelected('chat')
    await recovery.catchUp('chat', true)
    recovery.observe('chat', {
      snapshotSequence: '100',
      mutationRevision: '3',
      visibilityRevision: '2',
      clearedThroughSequence: '80',
    })
    for (let index = 0; index < 2000; index += 1)
      recovery.observe(`other-${index}`, {
        snapshotSequence: '100',
        mutationRevision: '1',
        visibilityRevision: '1',
      })
    expect(Object.keys(recovery.visibleWindows()).length).toBeLessThanOrEqual(101)
    expect(recovery.revisionKey('chat')).toBe('3:2')
    expect(recovery.acceptsSaved('chat', 'message-80', '80')).toBe(false)
    expect(recovery.revisionKey('other-0')).toBe('0:0')
    expect(recovery.acceptsSaved('other-0', 'message-80', '80')).toBe(false)
    recovery.dispose()
  })
  it('withholds an excluded queued frame below the snapshot watermark even above a detached baseline', async () => {
    let hidden = false
    let release!: (page: ReturnType<typeof snapshot>) => void
    const pending = new Promise<ReturnType<typeof snapshot>>((resolve) => {
      release = resolve
    })
    const metadata = {
      snapshotSequence: '100',
      mutationRevision: '0',
      visibilityRevision: '1',
      clearedThroughSequence: '0',
      globalClearedThroughSequence: '0',
    }
    const resolve = vi.fn(async (_id: string, _ids: string[]) => ({ ...metadata, messages: [] }))
    const { recovery } = connectedRecovery({
      latest: async () =>
        hidden ? { ...snapshot([], '90', '100', '0', '1') } : snapshot([message('1')], '0', '1'),
      after: async () => pending,
      older: async () => snapshot([], '0', '0'),
      visibility: async () => ({ ...metadata, hidden: false }),
      resolve,
    })
    await recovery.catchUp('chat', true)
    recovery.reveal(
      'chat',
      [{ ...message('80'), body: 'removed secret' }],
      recovery.beginNavigation(),
      { ...snapshot([message('80')], '70', '80'), snapshotSequence: '100' },
    )
    hidden = true
    await recovery.synchronize('chat', { visibilityRevision: '1' })
    expect(recovery.baseline('chat')).toBe('1')
    recovery.patch('chat', [{ ...message('80'), body: 'removed secret', messageVersion: '2' }])
    expect(JSON.stringify(recovery.visibleWindows())).not.toContain('removed secret')
    const saved = recovery.onLive(
      { ...message('80'), body: 'removed secret' },
      'group:chat',
      () => true,
    )
    try {
      await Promise.resolve()
      await Promise.resolve()
      expect(JSON.stringify(recovery.visibleWindows())).not.toContain('removed secret')
      expect(resolve).toHaveBeenCalledWith('chat', ['message-80'])
    } finally {
      release({ ...snapshot([], '1', '100', '0', '1') })
      await saved
      recovery.dispose()
    }
  })
  it('applies certified absent sequences while keeping human reads separate', async () => {
    const resolve = vi.fn(async () => ({
      snapshotSequence: '110',
      mutationRevision: '0',
      visibilityRevision: '0',
      clearedThroughSequence: '0',
      globalClearedThroughSequence: '0',
      messages: [],
    }))
    const { recovery, frames } = connectedRecovery({
      latest: async () => snapshot([message('103'), message('108')], '100', '110'),
      after: async () => snapshot([], '110', '110'),
      older: async () => snapshot([], '0', '100'),
      resolve,
    })
    await recovery.catchUp('chat', true)
    expect(recovery.visibleWindows().chat.map((row) => row.sequence)).toEqual(['103', '108'])
    expect(recovery.baseline('chat')).toBe('110')
    expect(frames).toEqual([
      { type: 'dismissed', version: 1, chatId: 'chat', sequence: '100' },
      { type: 'applied', version: 1, chatId: 'chat', sequence: '110' },
    ])
    await recovery.onLive(message('111'), 'group:chat', () => true)
    expect(recovery.visibleWindows().chat.at(-1)?.sequence).toBe('111')
    expect(recovery.baseline('chat')).toBe('111')
    expect(resolve).not.toHaveBeenCalled()
    recovery.dispose()
  })

  it('continues through an empty certified page and a deleted tail', async () => {
    const after = vi.fn(async (_id: string, sequence: string) =>
      sequence === '100'
        ? { ...snapshot([], '100', '140'), snapshotSequence: '160', hasMore: true }
        : snapshot([message('145')], '140', '160'),
    )
    const { recovery } = connectedRecovery(
      {
        latest: async () => snapshot([], '0', '160'),
        after,
        older: async () => snapshot([], '0', '0'),
      },
      baselineStorage('100'),
    )
    await recovery.catchUp('chat')
    expect(after.mock.calls).toEqual([
      ['chat', '100'],
      ['chat', '140'],
    ])
    expect(recovery.baseline('chat')).toBe('160')
    expect(recovery.visibleWindows().chat.map((row) => row.sequence)).toEqual(['145'])
    recovery.dispose()
  })

  it('removes a clear from visible and pinned rows and rejects a pending older snapshot', async () => {
    let page = snapshot([message('1'), message('2')], '0', '2')
    const history = {
      latest: async () => page,
      after: async () => snapshot([], '2', '2'),
      older: async () => snapshot([], '0', '0'),
      visibility: async () => ({
        snapshotSequence: '2',
        mutationRevision: '1',
        visibilityRevision: '1',
        clearedThroughSequence: '1',
        globalClearedThroughSequence: '0',
        hidden: false,
      }),
      resolve: async (_id: string, ids: string[]) => ({
        snapshotSequence: '2',
        mutationRevision: '1',
        visibilityRevision: '1',
        clearedThroughSequence: '1',
        globalClearedThroughSequence: '0',
        messages: ids.includes('message-2') ? [message('2')] : [],
      }),
    }
    const { recovery } = connectedRecovery(history)
    await recovery.catchUp('chat', true)
    let release!: (value: typeof page) => void
    const pending = recovery.withHistorySnapshot(
      'chat',
      () =>
        new Promise<typeof page>((resolve) => {
          release = resolve
        }),
      (value) => recovery.reveal('chat', value.messages, recovery.beginNavigation(), value),
    )
    page = { ...snapshot([message('2')], '0', '2', '1', '1'), clearedThroughSequence: '1' }
    await recovery.synchronize('chat', { mutationRevision: '1', visibilityRevision: '1' })
    release(snapshot([message('1'), message('2')], '0', '2'))
    expect(await pending).toBeUndefined()
    expect(recovery.visibleWindows().chat.map((row) => row.sequence)).toEqual(['2'])
    expect(recovery.latestWindows().chat.map((row) => row.sequence)).toEqual(['2'])
    await recovery.onLive(message('1'), 'group:chat', () => true)
    expect(recovery.visibleWindows().chat.map((row) => row.sequence)).toEqual(['2'])
    recovery.dispose()
  })

  it('removes explicit absences and quote bodies from both retained windows', async () => {
    const original = { ...message('1'), body: 'removed body' }
    const reply = {
      ...message('2'),
      replyToMessageId: original.id,
      replySenderId: original.senderId,
      replyBody: original.body,
      replyDeleted: false,
      replyVersion: '1',
    }
    const { recovery } = connectedRecovery({
      latest: async () => snapshot([original, reply], '0', '2'),
      older: async () => snapshot([], '0', '0'),
      after: async () => snapshot([], '2', '2'),
    })
    await recovery.catchUp('chat', true)
    recovery.applyChanges(
      'chat',
      [
        {
          revision: '1',
          kind: 'REMOVED',
          message: null,
          messageId: original.id,
          sequence: '1',
          clearedThroughSequence: null,
        },
      ],
      { mutationRevision: '1' },
    )
    expect(recovery.visibleWindows().chat).toHaveLength(1)
    expect(recovery.visibleWindows().chat[0].replyBody).toBeNull()
    expect(JSON.stringify(recovery.latestWindows())).not.toContain('removed body')
    recovery.dispose()
  })

  it('restores an evicted location in one around request and adopts a surviving anchor', async () => {
    const locations = vi.fn()
    const around = vi.fn(async () => ({
      ...snapshot([message('499999'), message('500001')], '499998', '500001'),
      snapshotSequence: '1000000',
      anchorMessageId: 'message-500001',
      hasOlder: true,
      hasNewer: true,
    }))
    const recovery = new ChatRecovery('device', memoryStorage())
    let selected = 'chat'
    const runtime: RecoveryRuntime = {
      history: {
        latest: async () => snapshot([message('1000000')], '999999', '1000000'),
        after: async () => snapshot([], '1000000', '1000000'),
        older: async () => snapshot([], '0', '0'),
        around,
      },
      context: (id) => ({
        selected: selected === id,
        connected: true,
        readingHistory: false,
        removed: false,
        room: 'group:chat',
        kind: 'GROUP',
      }),
      changed: () => {},
      sendFrame: () => {},
      jumped: () => {},
      failed: () => {},
      recovered: () => {},
      locationRestored: locations,
    }
    recovery.configure(runtime)
    await recovery.catchUp('chat', true)
    recovery.rememberLocation('chat', {
      messageId: 'message-500000',
      sequence: '500000',
      offsetPx: -17,
      atLatest: false,
    })
    selected = 'other'
    recovery.onSelected('other')
    selected = 'chat'
    recovery.onSelected('chat')
    recovery.onSocketOpened('chat')
    await vi.waitFor(() =>
      expect(locations).toHaveBeenCalledWith('chat', {
        messageId: 'message-500001',
        sequence: '500001',
        offsetPx: -17,
        atLatest: false,
      }),
    )
    expect(around).toHaveBeenCalledExactlyOnceWith('chat', 'message-500000', '500000')
    expect(recovery.visibleWindows().chat.map((row) => row.sequence)).toEqual(['499999', '500001'])
    expect(recovery.latestWindows().chat.at(-1)?.sequence).toBe('1000000')
    expect(recovery.baseline('chat')).toBe('1000000')
    recovery.dispose()
  })
})
