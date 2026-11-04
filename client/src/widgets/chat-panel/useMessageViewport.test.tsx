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
