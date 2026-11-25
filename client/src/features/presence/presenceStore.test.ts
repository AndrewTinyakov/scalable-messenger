import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { OutgoingSocketFrame } from '../../shared/api/socket'
import { MAX_WATCHED, PresenceStore, UNWATCH_DELAY_MS } from './presenceStore'

const id = (n: number) => `01ARZ3NDEKTSV4RRFFQ${String(n).padStart(7, '0')}`
const range = (from: number, count: number) => Array.from({ length: count }, (_, n) => id(from + n))
let sent: OutgoingSocketFrame[]
let store: PresenceStore
const sidebar = {}
const header = {}

beforeEach(() => {
  vi.useFakeTimers()
  sent = []
  store = new PresenceStore()
  store.connect((frame) => sent.push(frame))
})
afterEach(() => vi.useRealTimers())

const watches = () => sent.filter((frame) => frame.type === 'watch_presence')
const added = () => watches().flatMap((frame) => ('add' in frame ? (frame.add ?? []) : []))

it('watches a user once for every source and unwatches only after a delay', async () => {
  store.watch('sidebar', sidebar, [id(1), id(2)])
  store.watch('header', header, [id(1)])
  await vi.advanceTimersByTimeAsync(1000)
  expect(watches().at(-1)).toEqual({
    type: 'watch_presence',
    version: 1,
    add: [id(1), id(2)],
    remove: [],
  })
  store.watch('sidebar', sidebar, [])
  await vi.advanceTimersByTimeAsync(UNWATCH_DELAY_MS / 2)
  store.watch('sidebar', sidebar, [id(2)])
  await vi.advanceTimersByTimeAsync(UNWATCH_DELAY_MS * 2)
  expect(watches()).toHaveLength(2)
  store.watch('sidebar', sidebar, [])
  store.watch('header', header, [])
  await vi.advanceTimersByTimeAsync(UNWATCH_DELAY_MS + 1000)
  expect(watches().at(-1)).toMatchObject({
    add: [],
    remove: expect.arrayContaining([id(1), id(2)]),
  })
})

it('sends new users promptly while an unwatch is pending', async () => {
  store.watch('header', header, [id(1)])
  await vi.advanceTimersByTimeAsync(1000)
  store.watch('header', header, [])
  await vi.advanceTimersByTimeAsync(1000)
  store.watch('header', header, [id(2)])
  await vi.advanceTimersByTimeAsync(1000)
  expect(added()).toContain(id(2))
})

it('keeps each consumer of a source independent', async () => {
  const preview = {}
  const dialog = {}
  store.watch('members', dialog, [id(1)])
  store.watch('members', preview, [id(1), id(2)])
  store.watch('members', preview, [])
  await vi.advanceTimersByTimeAsync(UNWATCH_DELAY_MS + 2000)
  expect(added()).toContain(id(1))
  expect(watches().flatMap((frame) => frame.remove ?? [])).not.toContain(id(1))
})

it('fills the global cap with members before the sidebar and evicts only what it must', async () => {
  store.watch('header', header, [id(1)])
  store.watch('sidebar', sidebar, range(2000, 200))
  store.watch('members', {}, range(1000, 350))
  await vi.advanceTimersByTimeAsync(1000)
  expect(added()).toHaveLength(MAX_WATCHED)
  expect(added()).toContain(id(1))
  expect(added()).toEqual(expect.arrayContaining(range(1000, 350)))
  store.watch('members', {}, [])
  store.watch('sidebar', sidebar, range(3000, 20))
  await vi.advanceTimersByTimeAsync(1000)
  const last = watches().at(-1)!
  expect(last.add).toHaveLength(20)
  expect(last.remove).toHaveLength(20)
})

it('gives online count changes a turn while presence keeps changing', async () => {
  for (let n = 0; n < 5; n++) {
    store.watch('sidebar', sidebar, [id(100 + n)])
    if (n === 1) store.watchOnlineCount(id(9), 3)
    await vi.advanceTimersByTimeAsync(1000)
  }
  expect(sent.some((frame) => frame.type === 'watch_online_count')).toBe(true)
})

it('refreshes the online count after a membership change and coalesces rate-limit resyncs', async () => {
  store.watch('sidebar', sidebar, [id(1)])
  store.watchOnlineCount(id(9), 3)
  await vi.advanceTimersByTimeAsync(2000)
  const counts = () => sent.filter((frame) => frame.type === 'watch_online_count').length
  const before = counts()
  store.onEvent({
    type: 'member_removed',
    version: 1,
    chatId: id(9),
    memberId: id(5),
    eventId: id(6),
    room: `group:${id(9)}`,
    epoch: 'e',
    streamId: '1-0',
    seq: '2',
    userSeq: '1',
  } as never)
  await vi.advanceTimersByTimeAsync(1000)
  expect(counts()).toBe(before + 1)
  const resets = () => watches().filter((frame) => frame.reset).length
  const resetsBefore = resets()
  store.onEvent({ type: 'error', version: 1, code: 'RATE_LIMITED' })
  store.onEvent({ type: 'error', version: 1, code: 'RATE_LIMITED' })
  await vi.advanceTimersByTimeAsync(5000)
  expect(resets()).toBe(resetsBefore + 1)
})

it('paces the online count with presence and keys it by group size', async () => {
  const chat = id(9)
  store.watchOnlineCount(chat, 3)
  await vi.advanceTimersByTimeAsync(1000)
  expect(sent.at(-1)).toEqual({ type: 'watch_online_count', version: 1, chatId: chat })
  store.watchOnlineCount(chat, 4)
  await vi.advanceTimersByTimeAsync(1000)
  expect(sent.filter((frame) => frame.type === 'watch_online_count')).toHaveLength(2)
})

it('resets the whole watch on reconnect, while released and after a rate limit', async () => {
  store.watch('sidebar', sidebar, [id(1)])
  store.watchOnlineCount(id(9), 2)
  await vi.advanceTimersByTimeAsync(2000)
  store.connect((frame) => sent.push(frame))
  expect(watches().at(-1)).toEqual({
    type: 'watch_presence',
    version: 1,
    reset: true,
    add: [id(1)],
  })
  store.setReleased(true)
  expect(watches().at(-1)).toEqual({ type: 'watch_presence', version: 1, reset: true, add: [] })
  expect(sent.at(-1)).toEqual({ type: 'watch_online_count', version: 1 })
  store.setReleased(false)
  await vi.advanceTimersByTimeAsync(1000)
  expect(sent.at(-1)).toEqual({ type: 'watch_online_count', version: 1, chatId: id(9) })
  const before = watches().length
  store.onEvent({ type: 'error', version: 1, code: 'RATE_LIMITED' })
  await vi.advanceTimersByTimeAsync(4000)
  expect(watches()).toHaveLength(before + 1)
  expect(watches().at(-1)).toMatchObject({ reset: true, add: [id(1)] })
})

it('keeps the latest status, unavailable users, counts and server timing', () => {
  const listener = vi.fn()
  store.subscribe(listener)
  store.onEvent({
    type: 'presence',
    version: 1,
    statuses: [{ userId: id(1), online: true }],
    unavailable: [id(2)],
  })
  store.onEvent({ type: 'online_count', version: 1, chatId: id(3), online: 1, members: 2 })
  store.onEvent({
    type: 'presence_config',
    version: 1,
    idleAfterHiddenMs: 1,
    idleAfterInputMs: 2000,
    releaseAfterHiddenMs: 3000,
  })
  const snapshot = store.getSnapshot()
  expect(snapshot.statuses.get(id(1))).toEqual({ userId: id(1), online: true })
  expect(snapshot.statuses.get(id(2))).toEqual({ userId: id(2), unavailable: true })
  expect(snapshot.onlineCounts.get(id(3))).toEqual({ online: 1, members: 2 })
  expect(store.config.idleAfterInputMs).toBe(2000)
  expect(listener).toHaveBeenCalledTimes(2)
})
