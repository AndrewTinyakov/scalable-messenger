import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { message } from '../../entities/message/chatRecovery.fixtures'
import { useMessageViewport } from './useMessageViewport'

let dom: JSDOM
let root: Root
let container: HTMLDivElement

function Viewport({
  hasNewer,
  report,
}: {
  hasNewer: boolean
  report: (atLatest: boolean) => void
}) {
  const { scrollRef } = useMessageViewport({
    chatId: 'chat',
    userId: 'me',
    messages: [message('1')],
    pendingState: '',
    jumpRevision: 0,
    hasOlder: false,
    hasNewer,
    loadingOlder: false,
    loadingNewer: false,
    onLoadOlder: () => {},
    onLoadNewer: () => {},
    onViewPositionChange: report,
    announce: () => {},
  })
  return <div ref={scrollRef} />
}

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  dom.window.close()
  vi.unstubAllGlobals()
})

describe('message viewport position', () => {
  it('reports the latest position when newer history runs out without any scroll event', async () => {
    const report = vi.fn()
    await act(async () => root.render(<Viewport hasNewer report={report} />))
    expect(report).toHaveBeenLastCalledWith(false)
    await act(async () => root.render(<Viewport hasNewer={false} report={report} />))
    expect(report).toHaveBeenLastCalledWith(true)
  })
})

function PagingViewport({ sequence, load }: { sequence: string; load(): void }) {
  const { scrollRef, handleScroll } = useMessageViewport({
    chatId: 'chat',
    userId: 'me',
    messages: [message(sequence)],
    pendingState: '',
    jumpRevision: 0,
    hasOlder: true,
    hasNewer: false,
    loadingOlder: false,
    loadingNewer: false,
    onLoadOlder: load,
    onLoadNewer: () => {},
    onViewPositionChange: () => {},
    announce: () => {},
  })
  return <div ref={scrollRef} onScroll={handleScroll} />
}

it('spaces pages even when each response changes the history anchor', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    const load = vi.fn()
    await act(async () => root.render(<PagingViewport sequence="2" load={load} />))
    const scroller = container.firstElementChild!
    await act(async () => scroller.dispatchEvent(new dom.window.Event('scroll')))
    expect(load).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + 100)
    await act(async () => root.render(<PagingViewport sequence="1" load={load} />))
    await act(async () => scroller.dispatchEvent(new dom.window.Event('scroll')))
    expect(load).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + 200)
    await act(async () => scroller.dispatchEvent(new dom.window.Event('scroll')))
    expect(load).toHaveBeenCalledTimes(2)
  } finally {
    vi.useRealTimers()
  }
})

it('keeps bottom intent through append, trim, and pending resolution scroll events until user input', async () => {
  const resizeCallbacks: (() => void)[] = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resizeCallbacks.push(callback)
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  const report = vi.fn()
  let rows = Array.from({ length: 200 }, (_, index) => message(String(index + 1)))
  let pending = 'pending'
  function Harness() {
    const { scrollRef, handleScroll } = useMessageViewport({
      chatId: 'chat',
      userId: 'me',
      messages: rows,
      pendingState: pending,
      jumpRevision: 0,
      hasOlder: false,
      hasNewer: false,
      loadingOlder: false,
      loadingNewer: false,
      onLoadOlder: () => {},
      onLoadNewer: () => {},
      onViewPositionChange: report,
      announce: () => {},
    })
    return (
      <div ref={scrollRef} onScroll={handleScroll}>
        <div />
      </div>
    )
  }
  await act(async () => root.render(<Harness />))
  const scroller = container.firstElementChild as HTMLElement
  let height = 10000
  let top = 0
  Object.defineProperties(scroller, {
    scrollHeight: { get: () => height },
    clientHeight: { get: () => 600 },
    scrollTop: {
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(value, height - 600))
      },
    },
  })
  pending = 'pending-2'
  await act(async () => root.render(<Harness />))
  expect(top).toBe(9400)
  report.mockClear()
  await act(async () => scroller.dispatchEvent(new dom.window.WheelEvent('wheel', { deltaY: 100 })))
  height += 196
  await act(async () => scroller.dispatchEvent(new dom.window.Event('scroll')))
  expect(report).toHaveBeenLastCalledWith(true)
  rows = [...rows.slice(1), message('201')]
  pending = ''
  await act(async () => root.render(<Harness />))
  expect(top).toBe(height - 600)
  expect(report.mock.calls.every(([latest]) => latest === true)).toBe(true)
  height += 77
  await act(async () => {
    for (const resize of resizeCallbacks) resize()
  })
  expect(top).toBe(height - 600)
  await act(async () =>
    scroller.dispatchEvent(new dom.window.WheelEvent('wheel', { deltaY: -300 })),
  )
  top -= 300
  await act(async () => scroller.dispatchEvent(new dom.window.Event('scroll')))
  expect(report).toHaveBeenLastCalledWith(false)
  const readingTop = top
  rows = [...rows.slice(1), message('202')]
  height += 100
  await act(async () => root.render(<Harness />))
  expect(top).toBe(readingTop)
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    await act(async () =>
      scroller.dispatchEvent(new dom.window.WheelEvent('wheel', { deltaY: 900 })),
    )
    top = height - 600
    await act(async () => scroller.dispatchEvent(new dom.window.Event('scroll')))
    expect(report).toHaveBeenLastCalledWith(true)
    vi.setSystemTime(Date.now() + 2000)
    await act(async () =>
      scroller.firstElementChild!.dispatchEvent(
        new dom.window.FocusEvent('focusin', { bubbles: true }),
      ),
    )
    top -= 400
    await act(async () => scroller.dispatchEvent(new dom.window.Event('scroll')))
    expect(top).toBe(height - 1000)
    expect(report).toHaveBeenLastCalledWith(false)
  } finally {
    vi.useRealTimers()
  }
})
