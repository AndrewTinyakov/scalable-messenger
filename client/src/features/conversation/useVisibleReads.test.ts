import { JSDOM } from 'jsdom'
import { act, createElement, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { message } from '../../entities/message/chatRecovery.fixtures'
import { useVisibleReads } from './useVisibleReads'

it('starts a fresh dwell when a tall row settles without input', async () => {
  const dom = new JSDOM('<body><main></main></body>', { pretendToBeVisual: true })
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  let settled = false
  let focused = true
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
  const read = vi.fn()
  const rect = (height: number) => ({ top: 0, bottom: height, height }) as DOMRect
  const root = createRoot(document.querySelector('main')!)
  function Harness() {
    const ref = useRef<HTMLDivElement>(null)
    useVisibleReads(ref, [message('1')], 'reader', 'chat', '0', read, () => settled)
    return createElement(
      'div',
      { ref },
      createElement('div', { 'data-message-id': message('1').id }),
    )
  }
  try {
    await act(async () => root.render(createElement(Harness)))
    const viewport = document.querySelector('main > div')!
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect(600))
    vi.spyOn(viewport.firstElementChild!, 'getBoundingClientRect').mockReturnValue(rect(900))
    await act(async () => vi.advanceTimersByTime(800))
    expect(read).not.toHaveBeenCalled()
    settled = true
    await act(async () => viewport.dispatchEvent(new dom.window.Event('reading-settled')))
    await act(async () => vi.advanceTimersByTime(300))
    settled = false
    await act(async () => viewport.dispatchEvent(new dom.window.Event('reading-settled')))
    await act(async () => vi.advanceTimersByTime(800))
    expect(read).not.toHaveBeenCalled()
    settled = true
    await act(async () => viewport.dispatchEvent(new dom.window.Event('reading-settled')))
    await act(async () => vi.advanceTimersByTime(1000))
    expect(read).toHaveBeenCalledWith('1')
    const geometry = vi.spyOn(viewport, 'getBoundingClientRect')
    geometry.mockClear()
    await act(async () => vi.advanceTimersByTime(10000))
    expect(geometry).not.toHaveBeenCalled()
    focused = false
    await act(async () => window.dispatchEvent(new dom.window.Event('blur')))
  } finally {
    await act(async () => root.unmount())
    vi.useRealTimers()
    vi.unstubAllGlobals()
    dom.window.close()
  }
})
