import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { message } from '../../entities/message/chatRecovery.fixtures'
import { pagingFailure, resetPagingFailures } from '../../entities/message/pagingFailures'
import { ApiError } from '../../shared/api/http'
import { useMessageViewport } from './useMessageViewport'

it.each(['older', 'newer', 'empty older', 'empty newer'] as const)(
  'automatically pages %s in a short viewport and retries a failed anchor without input',
  async (direction) => {
    const dom = new JSDOM('<body><main></main></body>', { pretendToBeVisual: true })
    vi.stubGlobal('window', dom.window)
    vi.stubGlobal('document', dom.window.document)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.useFakeTimers()
    const load = vi.fn()
    let loading = false
    function Harness() {
      const { scrollRef } = useMessageViewport({
        chatId: 'chat',
        userId: 'reader',
        messages: direction.startsWith('empty') ? [] : [message('1')],
        pendingState: '',
        jumpRevision: 0,
        hasOlder: direction.endsWith('older'),
        hasNewer: direction.endsWith('newer'),
        loadingOlder: loading,
        loadingNewer: loading,
        onLoadOlder: load,
        onLoadNewer: load,
        onViewPositionChange: () => {},
        announce: () => {},
      })
      return createElement('div', { ref: scrollRef })
    }
    const root = createRoot(document.querySelector('main')!)
    try {
      await act(async () => root.render(createElement(Harness)))
      await act(async () => vi.advanceTimersByTime(250))
      expect(load).toHaveBeenCalledTimes(1)
      loading = true
      await act(async () => root.render(createElement(Harness)))
      await act(async () => vi.advanceTimersByTime(2000))
      expect(load).toHaveBeenCalledTimes(1)
      loading = false
      await act(async () => root.render(createElement(Harness)))
      await act(async () => vi.advanceTimersByTime(500))
      expect(load).toHaveBeenCalledTimes(2)
      await act(async () => vi.advanceTimersByTime(500))
      expect(load).toHaveBeenCalledTimes(2)
      await act(async () => vi.advanceTimersByTime(1500))
      expect(load).toHaveBeenCalledTimes(3)
      await act(async () => {
        pagingFailure(
          'chat',
          direction.endsWith('older') ? 'older' : 'newer',
          new ApiError(403, 'forbidden'),
          1,
        )
      })
      const geometry = vi.spyOn(document.querySelector('main > div')!, 'getBoundingClientRect')
      await act(async () => vi.advanceTimersByTime(60000))
      expect(load).toHaveBeenCalledTimes(3)
      expect(geometry).not.toHaveBeenCalled()
      await act(async () => {
        resetPagingFailures('chat')
      })
      await act(async () => vi.advanceTimersByTime(30000))
      expect(load.mock.calls.length).toBeGreaterThan(3)
    } finally {
      await act(async () => root.unmount())
      vi.useRealTimers()
      vi.unstubAllGlobals()
      dom.window.close()
    }
  },
)
