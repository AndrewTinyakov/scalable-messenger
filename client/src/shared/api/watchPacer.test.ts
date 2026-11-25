import { afterEach, expect, it, vi } from 'vitest'
import { WatchPacer } from './watchPacer'

afterEach(() => vi.useRealTimers())

it('coalesces rapid tab and sidebar changes below the shared ten-per-ten-second limit', async () => {
  vi.useFakeTimers()
  const sent: { at: number; type: string; chatIds?: string[] }[] = []
  const pacer = new WatchPacer((frame) => sent.push({ ...frame, at: Date.now() }))
  for (let index = 0; index < 100; index++) {
    pacer.offer({ type: 'watch_sidebar', version: 1, chatIds: [String(index)] })
    await vi.advanceTimersByTimeAsync(50)
  }
  await vi.advanceTimersByTimeAsync(5000)
  expect(sent.length).toBeLessThanOrEqual(7)
  expect(sent.at(-1)).toMatchObject({ chatIds: ['99'] })
  expect(sent.slice(1).every((frame, index) => frame.at - sent[index].at >= 1500)).toBe(true)
  pacer.reset()
  expect(vi.getTimerCount()).toBe(0)
})
