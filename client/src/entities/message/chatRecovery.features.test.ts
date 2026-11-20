import { describe, expect, it, vi } from 'vitest'
import { MutationRecovery } from '../../features/conversation/mutationRecovery'
import { ApiError } from '../../shared/api/http'
import type { RecoveryHistory } from './chatRecovery'
import { baselineStorage, connectedRecovery, message } from './chatRecovery.fixtures'
import type { Message } from './model'

function page(start: number, size = 50) {
  return Array.from({ length: size }, (_, index) => message(String(start + index)))
}

describe('retained history navigation', () => {
  it('reveals a distant target without dismissing or applying its skipped prefix and returns to pinned latest immediately', async () => {
    let resolveLatest: ((value: { messages: Message[] }) => void) | undefined
    const { recovery, frames } = connectedRecovery({
      latest: () =>
        resolveLatest
          ? new Promise((resolve) => {
              resolveLatest = resolve
            })
          : Promise.resolve({ messages: page(999951) }),
      after: async () => ({ messages: [], nextSequence: '1000000', hasMore: false }),
      older: async () => ({ messages: [] }),
    })
    await recovery.catchUp('chat', true)
    const before = [...frames]
    const revision = recovery.beginNavigation()
    expect(recovery.reveal('chat', page(1), revision)).toBe(true)
    expect(recovery.visibleWindows().chat[0].sequence).toBe('1')
    expect(recovery.latestWindows().chat.at(-1)?.sequence).toBe('1000000')
    expect(recovery.baseline('chat')).toBe('1000000')
    expect(frames).toEqual(before)
    resolveLatest = () => {}
    const returning = recovery.showLatest('chat')
    expect(recovery.visibleWindows().chat.at(-1)?.sequence).toBe('1000000')
    resolveLatest!({ messages: page(999951) })
    await returning
    recovery.dispose()
  })

  it('retains at most 250 messages across thousands of bidirectional pages with a pinned latest page', async () => {
    const { recovery } = connectedRecovery({
      latest: async () => ({ messages: page(999951) }),
      older: async (_, before) => ({ messages: page(Number(before) - 50) }),
      after: async (_, after) => ({
        messages: page(Number(after) + 1),
        nextSequence: String(Number(after) + 50),
        hasMore: true,
      }),
    })
    await recovery.catchUp('chat', true)
    recovery.reveal('chat', page(500001), recovery.beginNavigation())
    for (let index = 0; index < 1000; index += 1) {
      await recovery.loadOlder('chat')
      const retained = new Set(
        [...recovery.visibleWindows().chat, ...recovery.latestWindows().chat].map(
          (item) => item.id,
        ),
      )
      expect(retained.size).toBeLessThanOrEqual(250)
    }
    for (let index = 0; index < 1000; index += 1) await recovery.loadNewer('chat')
    expect(recovery.visibleWindows().chat).toHaveLength(200)
    expect(recovery.latestWindows().chat).toHaveLength(50)
    expect(recovery.latestWindows().chat.at(-1)?.sequence).toBe('1000000')
    recovery.dispose()
  })

  it('rejects an older page after a new navigation even when its old boundary is visited again', async () => {
    let release!: (value: { messages: Message[] }) => void
    const { recovery } = connectedRecovery({
      latest: async () => ({ messages: page(951) }),
      older: () =>
        new Promise((resolve) => {
          release = resolve
        }),
      after: async () => ({ messages: [], hasMore: false, nextSequence: '1000' }),
    })
    await recovery.catchUp('chat', true)
    const paging = recovery.loadOlder('chat')
    recovery.reveal('chat', page(1), recovery.beginNavigation())
    recovery.reveal('chat', page(951), recovery.beginNavigation())
    release({ messages: page(901) })
    await paging
    expect(recovery.visibleWindows().chat[0].sequence).toBe('951')
    recovery.dispose()
  })

  it('keeps a tombstone and clears retained quote text when an older history response arrives', async () => {
    const original = { ...message('1'), body: 'private original', messageVersion: '1' }
    const reply = {
      ...message('2'),
      replyToMessageId: original.id,
      replySenderId: original.senderId,
      replyBody: original.body,
      replyVersion: '1',
      replyDeleted: false,
    }
    const { recovery } = connectedRecovery({
      latest: async () => ({ messages: [original, reply] }),
      older: async () => ({ messages: [] }),
      after: async () => ({ messages: [], hasMore: false, nextSequence: '2' }),
    })
    await recovery.catchUp('chat', true)
    recovery.patch('chat', [
      { ...original, body: '', deletedAt: '2026-11-04T10:00:00Z', messageVersion: '3' },
    ])
    await recovery.showLatest('chat')
    expect(recovery.visibleWindows().chat[0].body).toBe('')
    expect(recovery.visibleWindows().chat[1].replyBody).toBe('')
    expect(recovery.visibleWindows().chat[1].replyDeleted).toBe(true)
    recovery.dispose()
  })
})

describe('history snapshots racing with unseen mutations', () => {
  it.each(['older', 'newer', 'latest', 'catch-up', 'around'] as const)(
    'keeps edits, tombstones and quotes after the durable cursor advances during %s',
    async (source) => {
      const first = source === 'older' || source === 'around' ? 1 : 101
      const original = {
        ...message(String(first + 48)),
        body: 'private original',
        messageVersion: '1',
      }
      const edited = { ...message(String(first + 47)), body: 'original edit', messageVersion: '1' }
      const rows = page(first)
      rows[47] = edited
      rows[48] = original
      rows[49] = {
        ...rows[49],
        replyToMessageId: original.id,
        replySenderId: original.senderId,
        replyBody: original.body,
        replyDeleted: false,
        replyVersion: '1',
      }
      let release!: (value: { messages: Message[]; hasMore: boolean; nextSequence: string }) => void
      const delayed = new Promise<{ messages: Message[]; hasMore: boolean; nextSequence: string }>(
        (resolve) => {
          release = resolve
        },
      )
      let initialized = false
      const { recovery } = connectedRecovery({
        latest: () => (initialized ? delayed : Promise.resolve({ messages: page(51) })),
        older: () => delayed,
        after: () => delayed,
      })
      await recovery.catchUp('chat', true)
      initialized = true
      const cursors: string[] = []
      const mutations = [
        { ...original, body: '', deletedAt: '2026-11-04T10:00:00Z', messageVersion: '3' },
        { ...edited, body: 'edited body', messageVersion: '2' },
      ]
      const changes = new MutationRecovery({
        changes: async (_, after) => {
          cursors.push(after)
          return {
            changes: after === '0' ? mutations.map((item) => ({ seq: '1', message: item })) : [],
            lastSeq: '1',
            nextSeq: '1',
            resetRequired: false,
          }
        },
        patch: (id, messages) => recovery.patch(id, messages),
        reset: async () => {
          throw new Error('Unexpected reset')
        },
      })
      changes.select('chat')
      changes.snapshot('chat', '0')
      const loading =
        source === 'older'
          ? recovery.loadOlder('chat')
          : source === 'newer'
            ? recovery.loadNewer('chat')
            : source === 'latest'
              ? recovery.showLatest('chat')
              : source === 'catch-up'
                ? recovery.catchUp('chat')
                : recovery.withHistorySnapshot(
                    'chat',
                    () => delayed,
                    (result) =>
                      recovery.reveal('chat', result.messages, recovery.beginNavigation()),
                  )
      recovery.patch('chat', mutations)
      await changes.refresh()
      release({ messages: rows, hasMore: false, nextSequence: String(first + 49) })
      await loading
      await changes.refresh()
      expect(cursors).toEqual(['0', '1'])
      const visible = recovery.visibleWindows().chat
      expect(visible.find((item) => item.id === original.id)).toMatchObject({
        body: '',
        messageVersion: '3',
        deletedAt: '2026-11-04T10:00:00Z',
      })
      expect(visible.find((item) => item.id === edited.id)).toMatchObject({
        body: 'edited body',
        messageVersion: '2',
      })
      expect(visible.find((item) => item.sequence === String(first + 49))).toMatchObject({
        replyBody: '',
        replyDeleted: true,
        replyVersion: '3',
      })
      recovery.dispose()
    },
  )
})

describe('mutations arriving before their saved frames', () => {
  it.each([
    { position: 'adjacent', selected: true },
    { position: 'gap', selected: true },
    { position: 'adjacent', selected: false },
    { position: 'gap', selected: false },
  ])(
    'keeps a forward tombstone and quote for a $position saved frame with selected=$selected',
    async ({ position, selected }) => {
      let release!: (page: { messages: Message[]; hasMore: boolean; nextSequence: string }) => void
      const delayed = new Promise<{ messages: Message[]; hasMore: boolean; nextSequence: string }>(
        (resolve) => {
          release = resolve
        },
      )
      const history: RecoveryHistory = {
        latest: async () => ({ messages: page(51) }),
        older: async () => ({ messages: [] }),
        after: () => delayed,
      }
      const { recovery } = connectedRecovery(history)
      if (!selected)
        recovery.configure({
          history,
          context: () => ({
            selected,
            readingHistory: false,
            removed: false,
            connected: true,
            room: 'group:chat',
          }),
          changed: () => {},
          sendFrame: () => {},
          jumped: () => {},
          failed: () => {},
          recovered: () => {},
        })
      await recovery.catchUp('chat', true)
      const original = {
        ...message(position === 'gap' ? '102' : '101'),
        body: 'private original',
        messageVersion: '1',
      }
      recovery.patch('chat', [
        { ...original, body: '', deletedAt: '2026-11-04T10:00:00Z', messageVersion: '3' },
      ])
      if (position === 'gap') await recovery.onLive(message('101'), 'group:chat', () => true)
      const saved = recovery.onLive(original, 'group:chat', () => true)
      const reply = {
        ...message(String(Number(original.sequence) + 1)),
        replyToMessageId: original.id,
        replySenderId: original.senderId,
        replyBody: original.body,
        replyDeleted: false,
        replyVersion: '1',
      }
      const replySaved = recovery.onLive(reply, 'group:chat', () => true)
      if (position === 'gap') {
        release({ messages: [message('101'), original], hasMore: false, nextSequence: '102' })
        await recovery.catchUp('chat')
      }
      await Promise.all([saved, replySaved])
      const visible = recovery.visibleWindows().chat
      if (selected)
        expect(visible.find((item) => item.id === original.id)).toMatchObject({
          body: '',
          messageVersion: '3',
        })
      expect(visible.find((item) => item.id === reply.id)).toMatchObject({
        replyBody: '',
        replyDeleted: true,
        replyVersion: '3',
      })
      recovery.dispose()
    },
  )
})

it('patches a catch-up row buffered across settled HTTP requests', async () => {
  let calls = 0
  let release!: (page: { messages: Message[]; hasMore: boolean; nextSequence: string }) => void
  const delayed = new Promise<{ messages: Message[]; hasMore: boolean; nextSequence: string }>(
    (resolve) => {
      release = resolve
    },
  )
  const original = { ...message('3'), body: 'private original', messageVersion: '1' }
  const { recovery } = connectedRecovery({
    latest: async () => ({ messages: [message('1')] }),
    older: async () => ({ messages: [] }),
    after: () =>
      ++calls === 1
        ? Promise.resolve({ messages: [original], hasMore: false, nextSequence: '3' })
        : delayed,
  })
  await recovery.catchUp('chat', true)
  await recovery.catchUp('chat')
  recovery.patch('chat', [
    { ...original, body: '', deletedAt: '2026-11-04T10:00:00Z', messageVersion: '3' },
  ])
  release({ messages: [message('2')], hasMore: false, nextSequence: '2' })
  await recovery.catchUp('chat')
  expect(recovery.visibleWindows().chat.find((item) => item.id === original.id)).toMatchObject({
    body: '',
    messageVersion: '3',
  })
  expect(recovery.baseline('chat')).toBe('3')
  recovery.dispose()
})

it('does not rebuild an evicted window from an already applied saved frame', async () => {
  const { recovery } = connectedRecovery(
    {
      latest: async () => ({ messages: [] }),
      older: async () => ({ messages: [] }),
      after: async () => ({ messages: [], hasMore: false, nextSequence: '100' }),
    },
    baselineStorage('100'),
  )
  const original = { ...message('49'), body: 'private original', messageVersion: '1' }
  recovery.patch('chat', [
    { ...original, body: '', deletedAt: '2026-11-04T10:00:00Z', messageVersion: '3' },
  ])
  await recovery.onLive(original, 'group:chat', () => true)
  expect(recovery.visibleWindows().chat ?? []).toEqual([])
  expect(recovery.baseline('chat')).toBe('100')
  recovery.dispose()
})

it.each(['edit', 'delete'])(
  'reconciles a delayed saved reply after its unseen target %s was consumed',
  async (kind) => {
    const target = { ...message('1'), body: 'private original', messageVersion: '1' }
    const changed = {
      ...target,
      body: kind === 'delete' ? '' : 'current target',
      messageVersion: '2',
      deletedAt: kind === 'delete' ? '2026-11-04T10:00:00Z' : null,
    }
    const reply = {
      ...message('101'),
      body: 'reply',
      replyToMessageId: target.id,
      replySenderId: target.senderId,
      replyBody: target.body,
      replyVersion: '1',
      replyDeleted: false,
    }
    const current = {
      ...reply,
      replyBody: changed.body,
      replyVersion: '2',
      replyDeleted: kind === 'delete',
    }
    let release!: () => void
    const delayed = new Promise<{ messages: Message[]; hasMore: boolean; nextSequence: string }>(
      (resolve) => {
        release = () => resolve({ messages: [current], hasMore: false, nextSequence: '101' })
      },
    )
    const { recovery } = connectedRecovery({
      latest: async () => ({ messages: page(51) }),
      older: async () => ({ messages: [] }),
      after: () => delayed,
    })
    await recovery.catchUp('chat', true)
    const cursors: string[] = []
    const mutations = new MutationRecovery({
      changes: async (_chat, after) => {
        cursors.push(after)
        return {
          changes: after === '0' ? [{ seq: '1', message: changed }] : [],
          lastSeq: '1',
          nextSeq: '1',
          resetRequired: false,
        }
      },
      patch: (chat, changes) => recovery.patch(chat, changes),
      reset: async () => '1',
    })
    mutations.select('chat')
    mutations.snapshot('chat', '0')
    await mutations.refresh()
    expect(cursors).toEqual(['0'])
    const saved = recovery.onLive(reply, 'user:reader', () => true)
    expect(recovery.visibleWindows().chat.some((item) => item.id === reply.id)).toBe(false)
    release()
    await saved
    await mutations.refresh()
    expect(cursors).toEqual(['0', '1'])
    expect(recovery.visibleWindows().chat.find((item) => item.id === reply.id)).toMatchObject({
      replyBody: changed.body,
      replyVersion: '2',
      replyDeleted: kind === 'delete',
    })
    recovery.dispose()
  },
)

it('withholds an unknown target preview when authoritative recovery fails and repairs it on retry', async () => {
  const reply = {
    ...message('101'),
    replyToMessageId: 'message-1',
    replySenderId: 'sender',
    replyBody: 'private original',
    replyVersion: '1',
    replyDeleted: false,
  }
  let failed = true
  const current = { ...reply, replyBody: '', replyVersion: '2', replyDeleted: true }
  const { recovery, frames } = connectedRecovery({
    latest: async () => ({ messages: page(51) }),
    older: async () => ({ messages: [] }),
    after: async () => {
      if (failed) throw new Error('offline')
      return { messages: [current], hasMore: false, nextSequence: '101' }
    },
  })
  await recovery.catchUp('chat', true)
  await recovery.onLive(reply, 'user:reader', () => true)
  expect(recovery.visibleWindows().chat.some((item) => item.id === reply.id)).toBe(false)
  expect(recovery.baseline('chat')).toBe('100')
  expect(frames.at(-1)).toMatchObject({ type: 'received_message', sequence: '101' })
  failed = false
  await recovery.catchUp('chat')
  expect(recovery.visibleWindows().chat.find((item) => item.id === reply.id)).toMatchObject(current)
  recovery.dispose()
})

it('automatically retries a coalesced snapshot that predates a saved reply', async () => {
  vi.useFakeTimers()
  let release!: () => void
  let calls = 0
  const reply = {
    ...message('101'),
    replyToMessageId: 'message-1',
    replySenderId: 'sender',
    replyBody: 'old quote',
    replyVersion: '1',
    replyDeleted: false,
  }
  const current = { ...reply, replyBody: '', replyVersion: '2', replyDeleted: true }
  const older = new Promise<{ messages: Message[]; hasMore: boolean; nextSequence: string }>(
    (resolve) => {
      release = () => resolve({ messages: [], hasMore: false, nextSequence: '100' })
    },
  )
  const { recovery, frames } = connectedRecovery({
    latest: async () => ({ messages: page(51) }),
    older: async () => ({ messages: [] }),
    after: () =>
      ++calls === 1
        ? older
        : Promise.resolve({ messages: [current], hasMore: false, nextSequence: '101' }),
  })
  try {
    await recovery.catchUp('chat', true)
    const existing = recovery.catchUp('chat')
    const saved = recovery.onLive(reply, 'user:reader', () => true)
    expect(frames.at(-1)).toMatchObject({ type: 'received_message', sequence: '101' })
    release()
    await Promise.all([existing, saved])
    expect(recovery.latestSequences().chat).toBe('101')
    expect(recovery.visibleWindows().chat.some((item) => item.id === reply.id)).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toBe(2)
    expect(recovery.visibleWindows().chat.find((item) => item.id === reply.id)).toMatchObject(
      current,
    )
  } finally {
    recovery.dispose()
    vi.useRealTimers()
  }
})

it('releases receipt debt for a reply burst before its shared SQL catch-up completes', async () => {
  let release!: () => void
  let calls = 0
  const canonical = (sequence: number) => ({
    ...message(String(sequence)),
    replyToMessageId: 'message-1',
    replySenderId: 'sender',
    replyBody: '',
    replyVersion: '2',
    replyDeleted: true,
  })
  const pending = new Promise<{ messages: Message[]; hasMore: boolean; nextSequence: string }>(
    (resolve) => {
      release = () =>
        resolve({
          messages: Array.from({ length: 50 }, (_, index) => canonical(101 + index)),
          hasMore: true,
          nextSequence: '150',
        })
    },
  )
  const { recovery, frames } = connectedRecovery({
    latest: async () => ({ messages: page(51) }),
    older: async () => ({ messages: [] }),
    after: async (_, after) => {
      calls += 1
      if (after === '100') return pending
      const start = Number(after) + 1
      const rows = Array.from({ length: Math.min(50, 358 - start) }, (_, index) =>
        canonical(start + index),
      )
      return {
        messages: rows,
        hasMore: start + rows.length <= 357,
        nextSequence: rows.at(-1)!.sequence,
      }
    },
  })
  await recovery.catchUp('chat', true)
  const saved = Array.from({ length: 257 }, (_, index) =>
    recovery.onLive(
      { ...canonical(101 + index), replyBody: 'old quote', replyVersion: '1', replyDeleted: false },
      'user:reader',
      () => true,
    ),
  )
  expect(frames.filter((frame) => frame.type === 'received_message')).toHaveLength(257)
  expect(calls).toBe(1)
  release()
  await Promise.all(saved)
  expect(calls).toBe(6)
  expect(recovery.baseline('chat')).toBe('357')
  expect(
    recovery.visibleWindows().chat.every((row) => row.replyBody === '' && row.replyDeleted),
  ).toBe(true)
  recovery.dispose()
})

it('keeps a canonical reply in the pinned latest page before a refresh completes', async () => {
  const target = {
    ...message('1'),
    body: '',
    deletedAt: '2026-11-04T10:00:00Z',
    messageVersion: '2',
  }
  const reply = {
    ...message('101'),
    replyToMessageId: target.id,
    replySenderId: target.senderId,
    replyBody: 'private original',
    replyVersion: '1',
    replyDeleted: false,
  }
  const current = { ...reply, replyBody: '', replyVersion: '2', replyDeleted: true }
  let calls = 0
  let release!: () => void
  const { recovery } = connectedRecovery({
    latest: () =>
      ++calls === 1
        ? Promise.resolve({ messages: page(51) })
        : new Promise((resolve) => {
            release = () => resolve({ messages: [...page(52, 49), current] })
          }),
    older: async () => ({ messages: [] }),
    after: async () => ({ messages: [current], hasMore: false, nextSequence: '101' }),
  })
  await recovery.catchUp('chat', true)
  recovery.patch('chat', [target])
  await recovery.onLive(reply, 'user:reader', () => true)
  recovery.reveal('chat', [target], recovery.beginNavigation())
  const returning = recovery.showLatest('chat')
  expect(recovery.visibleWindows().chat.find((row) => row.id === reply.id)).toMatchObject(current)
  release()
  await returning
  expect(recovery.visibleWindows().chat.find((row) => row.id === reply.id)).toMatchObject(current)
  recovery.dispose()
})

it('fetches the bounded latest page when coalesced replies cross the catch-up limit mid-request', async () => {
  let release!: () => void
  let latestCalls = 0
  let afterCalls = 0
  const canonical = (sequence: number) => ({
    ...message(String(sequence)),
    replyToMessageId: 'message-1',
    replySenderId: 'sender',
    replyBody: '',
    replyVersion: '2',
    replyDeleted: true,
  })
  const pending = new Promise<{ messages: Message[]; hasMore: boolean; nextSequence: string }>(
    (resolve) => {
      release = () => resolve({ messages: [], hasMore: false, nextSequence: '100' })
    },
  )
  const { recovery, frames } = connectedRecovery({
    latest: async () => ({
      messages:
        ++latestCalls === 1
          ? page(51)
          : Array.from({ length: 50 }, (_, index) => canonical(552 + index)),
    }),
    older: async () => ({ messages: [] }),
    after: () => {
      afterCalls += 1
      return pending
    },
  })
  await recovery.catchUp('chat', true)
  const existing = recovery.catchUp('chat')
  const saved = Array.from({ length: 501 }, (_, index) =>
    recovery.onLive(
      { ...canonical(101 + index), replyBody: 'old quote', replyVersion: '1', replyDeleted: false },
      'user:reader',
      () => true,
    ),
  )
  expect(frames.filter((frame) => frame.type === 'received_message')).toHaveLength(501)
  release()
  await Promise.all([existing, ...saved])
  expect(afterCalls).toBe(1)
  expect(latestCalls).toBe(2)
  expect(recovery.latestWindows().chat).toHaveLength(50)
  expect(recovery.latestWindows().chat.at(-1)).toMatchObject(canonical(601))
  expect(recovery.visibleWindows().chat.at(-1)?.sequence).toBe('100')
  expect(recovery.baseline('chat')).toBe('100')
  await recovery.showLatest('chat')
  expect(recovery.visibleWindows().chat.at(-1)).toMatchObject(canonical(601))
  expect(recovery.baseline('chat')).toBe('601')
  recovery.dispose()
})

it.each([
  new ApiError(403, 'forbidden'),
  new ApiError(404, 'missing'),
  new Error('Invalid response from server'),
])('suspends failed paging until navigation changes: %s', async (cause) => {
  const older = vi.fn(async () => {
    throw cause
  })
  const { recovery } = connectedRecovery({
    latest: async () => ({ messages: page(51) }),
    after: async () => ({ messages: [], hasMore: false, nextSequence: '100' }),
    older,
  })
  await recovery.catchUp('chat', true)
  await expect(recovery.loadOlder('chat')).rejects.toBe(cause)
  for (let i = 0; i < 5; i++) await recovery.loadOlder('chat')
  expect(older).toHaveBeenCalledTimes(1)
  recovery.beginNavigation()
  await expect(recovery.loadOlder('chat')).rejects.toBe(cause)
  expect(older).toHaveBeenCalledTimes(2)
  recovery.dispose()
})

it('ignores a paging failure that lands after navigation moved on', async () => {
  let fail: (cause: unknown) => void = () => {}
  const older = vi
    .fn()
    .mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)))
    .mockResolvedValue({ messages: [], hasMore: false, nextSequence: '0' })
  const { recovery } = connectedRecovery({
    latest: async () => ({ messages: page(51) }),
    after: async () => ({ messages: [], hasMore: false, nextSequence: '100' }),
    older,
  })
  try {
    await recovery.catchUp('chat', true)
    const stale = recovery.loadOlder('chat')
    recovery.beginNavigation()
    fail(new ApiError(403, 'forbidden'))
    await expect(stale).rejects.toMatchObject({ status: 403 })
    await recovery.loadOlder('chat')
    expect(older).toHaveBeenCalledTimes(2)
  } finally {
    recovery.dispose()
  }
})

it('backs off transient paging failures without losing the edge', async () => {
  vi.useFakeTimers()
  const older = vi.fn(async () => {
    throw new ApiError(503, 'unavailable')
  })
  const { recovery } = connectedRecovery({
    latest: async () => ({ messages: page(51) }),
    after: async () => ({ messages: [], hasMore: false, nextSequence: '100' }),
    older,
  })
  try {
    await recovery.catchUp('chat', true)
    await expect(recovery.loadOlder('chat')).rejects.toMatchObject({ status: 503 })
    await recovery.loadOlder('chat')
    expect(older).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(recovery.loadOlder('chat')).rejects.toMatchObject({ status: 503 })
    await vi.advanceTimersByTimeAsync(1000)
    await recovery.loadOlder('chat')
    expect(older).toHaveBeenCalledTimes(2)
  } finally {
    recovery.dispose()
    vi.useRealTimers()
  }
})

describe('synchronizing quotes while every history slot is busy', () => {
  const quoted = { ...message('1'), body: 'original' }
  const reply = {
    ...message('2'),
    replyToMessageId: quoted.id,
    replyBody: quoted.body,
    replySenderId: quoted.senderId,
    replyVersion: '1',
    replyDeleted: false,
  }
  it.each([
    ['edit', 'edited'],
    ['EVERYONE', null],
    ['SELF', null],
  ] as const)('waits for capacity and applies the %s to the quote', async (operation, expected) => {
    let mutated = false
    const metadata = () => ({
      snapshotSequence: '2',
      mutationSeq: mutated && operation !== 'SELF' ? '1' : '0',
      memberSeq: mutated && operation === 'SELF' ? '1' : '0',
      clearedThroughSequence: '0',
      globalClearedThroughSequence: '0',
    })
    const current = () =>
      !mutated
        ? reply
        : operation === 'edit'
          ? { ...reply, replyBody: 'edited', replyVersion: '2' }
          : {
              ...reply,
              replyBody: null,
              replySenderId: null,
              replyVersion: null,
              replyDeleted: null,
            }
    const snapshot = () => ({
      ...metadata(),
      messages: [current()],
      coverageAfterSequence: '1',
      coverageThroughSequence: '2',
      nextSequence: '2',
      hasMore: false,
    })
    const { recovery } = connectedRecovery({
      latest: async () => snapshot(),
      after: async () => snapshot(),
      older: async () => snapshot(),
      visibility: async () => ({ ...metadata(), hidden: false }),
      resolve: async (_id, ids) => ({
        ...metadata(),
        messages: snapshot().messages.filter((row) => ids.includes(row.id)),
      }),
    })
    await recovery.catchUp('chat', true)
    const stale = snapshot()
    let release!: (page: typeof stale) => void
    const blocked = new Promise<typeof stale>((done) => {
      release = done
    })
    const busy = Array.from({ length: 16 }, () =>
      recovery.withHistorySnapshot(
        'chat',
        () => blocked,
        () => true,
      ),
    )
    mutated = true
    const synchronized = recovery.synchronize('chat', metadata())
    // Let synchronize reach its history requests while all slots are still taken.
    await new Promise((done) => setTimeout(done, 0))
    release(stale)
    await Promise.all([...busy, synchronized])
    // A later pass at the same revision must not treat the skipped work as verified.
    await recovery.synchronize('chat')
    expect(recovery.visibleWindows().chat[0].replyBody).toBe(expected)
    recovery.dispose()
  })
})
