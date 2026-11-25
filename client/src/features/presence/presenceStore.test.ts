import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { OutgoingSocketFrame } from '../../shared/api/socket'
import { MAX_WATCHED, PresenceStore, UNWATCH_DELAY_MS } from './presenceStore'

const id = (n: number) => `01ARZ3NDEKTSV4RRFFQ${String(n).padStart(7, '0')}`
let sent: OutgoingSocketFrame[]
let store: PresenceStore

beforeEach(() => {
  vi.useFakeTimers()
  sent = []
  store = new PresenceStore()
  store.connect((frame) => sent.push(frame))
})
afterEach(() => vi.useRealTimers())

const watches = () => sent.filter((frame) => frame.type === 'watch_presence')

it('watches a user once for every source and unwatches only after a delay', async () => {
  store.watch('sidebar', [id(1), id(2)])
  store.watch('header', [id(1)])
  await vi.advanceTimersByTimeAsync(1000)
  expect(watches().at(-1)).toEqual({
    type: 'watch_presence',
    version: 1,
    add: [id(1), id(2)],
    remove: [],
  })
  store.watch('sidebar', [])
  await vi.advanceTimersByTimeAsync(UNWATCH_DELAY_MS / 2)
  store.watch('sidebar', [id(2)])
  await vi.advanceTimersByTimeAsync(UNWATCH_DELAY_MS * 2)
  expect(watches()).toHaveLength(2)
  store.watch('sidebar', [])
  store.watch('header', [])
  await vi.advanceTimersByTimeAsync(UNWATCH_DELAY_MS + 1000)
  expect(watches().at(-1)).toMatchObject({
    add: [],
    remove: expect.arrayContaining([id(1), id(2)]),
  })
})

it('keeps pinned sources and evicts the sidebar first at the global cap', async () => {
  store.watch(
    'members',
    Array.from({ length: 100 }, (_, n) => id(1000 + n)),
  )
  store.watch('header', [id(1)])
  store.watch(
    'sidebar',
    Array.from({ length: 200 }, (_, n) => id(2000 + n)),
  )
  await vi.advanceTimersByTimeAsync(1000)
  const added = watches().flatMap((frame) => ('add' in frame ? (frame.add ?? []) : []))
  expect(added).toHaveLength(301)
  expect(added.length).toBeLessThanOrEqual(MAX_WATCHED)
  expect(added).toContain(id(1))
})

it('resets the whole watch on reconnect and while released', async () => {
  store.watch('sidebar', [id(1)])
  await vi.advanceTimersByTimeAsync(1000)
  store.connect((frame) => sent.push(frame))
  expect(watches().at(-1)).toEqual({
    type: 'watch_presence',
    version: 1,
    reset: true,
    add: [id(1)],
  })
  store.setReleased(true)
  expect(watches().at(-1)).toEqual({ type: 'watch_presence', version: 1, reset: true, add: [] })
  store.setReleased(false)
  expect(watches().at(-1)).toEqual({
    type: 'watch_presence',
    version: 1,
    reset: true,
    add: [id(1)],
  })
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
