import { afterEach, expect, it, vi } from 'vitest'
import { WatchPacer } from './watchPacer'

afterEach(() => vi.useRealTimers())

it('coalesces rapid tab and sidebar changes below the shared ten-per-ten-second limit', async () => {
  vi.useFakeTimers()
  const sent: { at: number; type: string; chatId?: string }[] = []
  const pacer = new WatchPacer((frame) => sent.push({ ...frame, at: Date.now() }))
  for (let index = 0; index < 100; index++) {
    pacer.offer({ type: 'watch_presence', version: 1, chatId: String(index), userIds: [] })
    pacer.offer({ type: 'watch_sidebar', version: 1, chatIds: [String(index)] })
    await vi.advanceTimersByTimeAsync(50)
  }
  await vi.advanceTimersByTimeAsync(5000)
  expect(sent.length).toBeLessThanOrEqual(7)
  expect(sent.filter((frame) => frame.type === 'watch_presence').at(-1)).toMatchObject({
    chatId: '99',
  })
  expect(sent.slice(1).every((frame, index) => frame.at - sent[index].at >= 1500)).toBe(true)
  pacer.reset()
  expect(vi.getTimerCount()).toBe(0)
})

it('cancels stale presence when leaving a chat', async () => {
  vi.useFakeTimers()
  const send = vi.fn()
  const pacer = new WatchPacer(send)
  pacer.offer({ type: 'watch_sidebar', version: 1, chatIds: [] })
  pacer.offer({ type: 'watch_presence', version: 1, chatId: 'old', userIds: [] })
  pacer.offer({ type: 'unwatch_presence', version: 1 })
  await vi.advanceTimersByTimeAsync(5000)
  expect(send.mock.calls.map(([frame]) => frame.type)).toEqual([
    'watch_sidebar',
    'unwatch_presence',
  ])
})
