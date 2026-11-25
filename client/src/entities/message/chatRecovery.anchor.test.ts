import { describe, expect, it, vi } from 'vitest'
import { ChatRecovery } from './chatRecovery'
import { memoryStorage, message } from './chatRecovery.fixtures'
import type { HistorySnapshot, SnapshotMetadata } from './historySnapshot'
import type { Message } from './model'

function page(
  messages: Message[],
  after: string,
  through: string,
  mutationSeq = '0',
  visibilitySeq = '0',
  hasMore = true,
): HistorySnapshot & SnapshotMetadata & { hasMore: boolean; nextSequence: string } {
  return {
    messages,
    snapshotSequence: '1000',
    mutationSeq,
    visibilitySeq,
    clearedThroughSequence: '0',
    globalClearedThroughSequence: '0',
    coverageAfterSequence: after,
    coverageThroughSequence: through,
    nextSequence: through,
    hasMore,
  }
}

function fixture() {
  let mutationSeq = '0'
  let visibilitySeq = '0'
  let release!: (value: ReturnType<typeof page>) => void
  let started!: () => void
  const newerStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  const newer = new Promise<ReturnType<typeof page>>((resolve) => {
    release = resolve
  })
  const restored = vi.fn()
  const around = vi.fn(async () =>
    mutationSeq !== '0' || visibilitySeq !== '0'
      ? {
          ...page([message('132')], '67', '181', mutationSeq, visibilitySeq),
          anchorMessageId: 'message-132',
          hasOlder: true,
          hasNewer: true,
        }
      : { ...page([], '84', '115'), anchorMessageId: null, hasOlder: true, hasNewer: true },
  )
  const recovery = new ChatRecovery('device', memoryStorage())
  const exposures: string[] = []
  recovery.configure({
    history: {
      latest: async () => page([message('1000')], '999', '1000', mutationSeq, visibilitySeq, false),
      around,
      older: async () => page([{ ...message('70'), body: 'personally erased secret' }], '68', '84'),
      after: async () => {
        started()
        return newer
      },
      visibility: async () => ({
        snapshotSequence: '1000',
        mutationSeq,
        visibilitySeq,
        clearedThroughSequence: '0',
        globalClearedThroughSequence: '0',
        hidden: false,
      }),
      resolve: async (_id, ids) => ({
        ...page([], '0', '1000', mutationSeq, visibilitySeq),
        messages: ids.includes('message-1000') ? [message('1000')] : [],
      }),
    },
    context: () => ({
      selected: true,
      connected: true,
      readingHistory: true,
      removed: false,
      room: 'group:chat',
      kind: 'GROUP',
    }),
    changed: () => {
      if (
        (mutationSeq !== '0' || visibilitySeq !== '0') &&
        JSON.stringify(recovery.visibleWindows()).includes('personally erased secret')
      )
        exposures.push('stale body')
    },
    sendFrame: () => {},
    jumped: () => {},
    failed: () => {},
    recovered: () => {},
    locationRestored: restored,
  })
  return {
    recovery,
    restored,
    around,
    exposures,
    newerStarted,
    release,
    change: (kind: 'mutation' | 'visibility') => {
      if (kind === 'mutation') mutationSeq = '1'
      else visibilitySeq = '1'
    },
    current: () => ({ mutationSeq, visibilitySeq }),
  }
}

describe('reading anchor proof', () => {
  it('restores an exact million-history target with one indexed around request', async () => {
    const restored = vi.fn()
    const around = vi.fn(async () => ({
      ...page([message('500000')], '499999', '500000'),
      snapshotSequence: '1000000',
      anchorMessageId: 'message-500000',
      hasOlder: true,
      hasNewer: true,
    }))
    const after = vi.fn(async () => page([], '500000', '1000000'))
    const older = vi.fn(async () => page([], '0', '499999'))
    const recovery = new ChatRecovery('device', memoryStorage())
    recovery.configure({
      history: {
        latest: async () => ({
          ...page([message('1000000')], '999999', '1000000'),
          snapshotSequence: '1000000',
        }),
        around,
        after,
        older,
      },
      context: () => ({
        selected: true,
        connected: true,
        readingHistory: true,
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
        messageId: 'message-500000',
        sequence: '500000',
        offsetPx: -17,
        atLatest: false,
      })
      recovery.onSelected('chat')
      await vi.waitFor(() =>
        expect(restored).toHaveBeenCalledWith('chat', {
          messageId: 'message-500000',
          sequence: '500000',
          offsetPx: -17,
          atLatest: false,
        }),
      )
      expect(around).toHaveBeenCalledExactlyOnceWith('chat', 'message-500000', '500000')
      expect(after).not.toHaveBeenCalled()
      expect(older).not.toHaveBeenCalled()
    } finally {
      recovery.dispose()
    }
  })
  it.each(['visibility', 'mutation'] as const)(
    'rejects held content after a newer %s snapshot and retries the original bookmark',
    async (kind) => {
      const f = fixture()
      try {
        await f.recovery.catchUp('chat', true)
        f.recovery.rememberLocation('chat', {
          messageId: 'message-100',
          sequence: '100',
          offsetPx: -17,
          atLatest: false,
        })
        f.recovery.onSelected('chat')
        await f.newerStarted
        f.change(kind)
        await f.recovery.synchronize('chat', f.current())
        expect(JSON.stringify(f.recovery.visibleWindows())).not.toContain(
          'personally erased secret',
        )
        for (let index = 0; index < 200; index += 1)
          f.recovery.observe(`other-${index}`, { mutationSeq: '1', visibilitySeq: '1' })
        f.release(page([], '115', '131', f.current().mutationSeq, f.current().visibilitySeq))
        await vi.waitFor(() =>
          expect(f.restored).toHaveBeenCalledWith('chat', {
            messageId: 'message-132',
            sequence: '132',
            offsetPx: -17,
            atLatest: false,
          }),
        )
        expect(f.around.mock.calls).toEqual([
          ['chat', 'message-100', '100'],
          ['chat', 'message-100', '100'],
        ])
        expect(f.exposures).toEqual([])
        expect(f.recovery.visibleWindows().chat[0].sequence).toBe('132')
        expect(f.recovery.readingLocation('chat')).toMatchObject({
          messageId: 'message-132',
          offsetPx: -17,
        })
      } finally {
        f.recovery.dispose()
      }
    },
  )

  it('overlays a newer accepted edit on a held candidate before installation', async () => {
    const f = fixture()
    try {
      await f.recovery.catchUp('chat', true)
      f.recovery.rememberLocation('chat', {
        messageId: 'message-100',
        sequence: '100',
        offsetPx: -17,
        atLatest: false,
      })
      f.recovery.onSelected('chat')
      await f.newerStarted
      f.recovery.patch('chat', [
        { ...message('70'), body: 'current edited body', messageVersion: '2' },
      ])
      f.release(page([], '115', '131'))
      await vi.waitFor(() =>
        expect(f.restored).toHaveBeenCalledWith('chat', {
          messageId: 'message-70',
          sequence: '70',
          offsetPx: -17,
          atLatest: false,
        }),
      )
      expect(f.recovery.visibleWindows().chat[0]).toMatchObject({
        body: 'current edited body',
        messageVersion: '2',
      })
    } finally {
      f.recovery.dispose()
    }
  })

  it('proves a non-null fallback against an unfinished nearer direction', async () => {
    const restored = vi.fn()
    const after = vi.fn(async () => ({
      ...page([message('71')], '65', '100'),
      snapshotSequence: '200',
    }))
    const around = vi.fn(async () => ({
      ...page([message('1')], '0', '65'),
      snapshotSequence: '200',
      anchorMessageId: 'message-1',
      hasOlder: false,
      hasNewer: true,
    }))
    const recovery = new ChatRecovery('device', memoryStorage())
    recovery.configure({
      history: {
        latest: async () => ({ ...page([message('200')], '199', '200'), snapshotSequence: '200' }),
        around,
        after,
        older: async () => page([], '0', '0', '0', '0', false),
      },
      context: () => ({
        selected: true,
        connected: true,
        readingHistory: true,
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
        messageId: 'message-50',
        sequence: '50',
        offsetPx: -17,
        atLatest: false,
      })
      recovery.onSelected('chat')
      await vi.waitFor(() =>
        expect(restored).toHaveBeenCalledWith('chat', {
          messageId: 'message-71',
          sequence: '71',
          offsetPx: -17,
          atLatest: false,
        }),
      )
      expect(around).toHaveBeenCalledExactlyOnceWith('chat', 'message-50', '50')
      expect(after).toHaveBeenCalledExactlyOnceWith('chat', '65')
      expect(recovery.visibleWindows().chat[0].sequence).toBe('71')
      expect(recovery.availability('chat').hasOlderMessages).toBe(true)
    } finally {
      recovery.dispose()
    }
  })
})
