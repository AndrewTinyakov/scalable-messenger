import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { watchActivity, type Activity } from './activity'

let dom: JSDOM
let focused: boolean
let hidden: boolean
const config = () => ({
  idleAfterHiddenMs: 5000,
  idleAfterInputMs: 30000,
  releaseAfterHiddenMs: 300000,
})

beforeEach(() => {
  vi.useFakeTimers()
  dom = new JSDOM('<!doctype html><html><body></body></html>')
  focused = true
  hidden = false
  Object.defineProperty(dom.window.document, 'visibilityState', {
    get: () => (hidden ? 'hidden' : 'visible'),
  })
  dom.window.document.hasFocus = () => focused
})
afterEach(() => {
  dom.window.close()
  vi.useRealTimers()
})

it('reports idle after hiding or no input, and active again on input', async () => {
  const changes: Activity[] = []
  const releases: boolean[] = []
  const stop = watchActivity(
    config,
    (activity) => changes.push(activity),
    (released) => releases.push(released),
    dom.window as unknown as Window,
  )
  expect(changes).toEqual([{ active: true, visible: true }])
  await vi.advanceTimersByTimeAsync(30000)
  expect(changes.at(-1)).toEqual({ active: false, visible: true })
  dom.window.dispatchEvent(new dom.window.Event('keydown'))
  expect(changes.at(-1)).toEqual({ active: true, visible: true })
  hidden = true
  focused = false
  dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'))
  expect(changes.at(-1)).toEqual({ active: true, visible: false })
  await vi.advanceTimersByTimeAsync(5000)
  expect(changes.at(-1)).toEqual({ active: false, visible: false })
  await vi.advanceTimersByTimeAsync(300000)
  expect(releases).toEqual([true])
  hidden = false
  focused = true
  dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'))
  expect(releases).toEqual([true, false])
  expect(changes.at(-1)).toEqual({ active: true, visible: true })
  stop()
})
