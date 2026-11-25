import { JSDOM } from 'jsdom'
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Chat } from '../../entities/chat/model'
import { connectedRecovery, message } from '../../entities/message/chatRecovery.fixtures'
import type { Message } from '../../entities/message/model'
import { ApiError, type api } from '../../shared/api/http'
import type { OutgoingSocketFrame } from '../../shared/api/socket'
import { useConversationFeatures } from './useConversationFeatures'
import { isReadVisible, useVisibleReads } from './useVisibleReads'

const alice = { id: '00000000000000000000000001', username: 'alice' }
const bob = { id: '00000000000000000000000002', username: 'bob' }
const chat: Chat = {
  id: 'chat',
  kind: 'DIRECT',
  members: [alice, bob],
  memberCount: 2,
  lastSequence: '0',
}
let dom: JSDOM
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  vi.useFakeTimers()
})
afterEach(async () => {
  await act(async () => root.unmount())
  vi.useRealTimers()
  dom.window.close()
  vi.unstubAllGlobals()
})

function rectangle(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    height: bottom - top,
    left: 0,
    right: 500,
    width: 500,
    x: 0,
    y: top,
    toJSON: () => ({}),
  }
}

describe('human read visibility', () => {
  it('requires a visible portion of tall messages and rejects offscreen rows', () => {
    expect(isReadVisible(rectangle(-300, 1100), rectangle(0, 600))).toBe(true)
    expect(isReadVisible(rectangle(590, 900), rectangle(0, 600))).toBe(false)
    expect(isReadVisible(rectangle(0, 0), rectangle(0, 600))).toBe(false)
  })
  it('waits for dwell and focus, excludes own messages and cancels messages crossed while scrolling', async () => {
    const onRead = vi.fn()
    const rows = [
      { ...message('1'), senderId: bob.id },
      { ...message('2'), senderId: alice.id },
      { ...message('3'), senderId: bob.id },
    ]
    let focused = false
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
    function Harness() {
      const ref = useRef<HTMLDivElement>(null)
      useVisibleReads(ref, rows, alice.id, chat.id, '0', onRead)
      return (
        <div ref={ref} data-scroller>
          {rows.map((row) => (
            <div key={row.id} data-message-id={row.id}>
              {row.body}
            </div>
          ))}
        </div>
      )
    }
    await act(async () => root.render(<Harness />))
    const viewport = container.querySelector<HTMLElement>('[data-scroller]')!
    viewport.getBoundingClientRect = () => rectangle(0, 600)
    const elements = [...container.querySelectorAll<HTMLElement>('[data-message-id]')]
    let thirdVisible = true
    for (const [index, element] of elements.entries())
      element.getBoundingClientRect = () =>
        index === 2 && !thirdVisible ? rectangle(700, 800) : rectangle(100, 200)
    await act(async () => {
      window.dispatchEvent(new dom.window.Event('focus'))
      await vi.advanceTimersByTimeAsync(800)
    })
    expect(onRead).not.toHaveBeenCalled()
    focused = true
    await act(async () => {
      window.dispatchEvent(new dom.window.Event('focus'))
      await vi.advanceTimersByTimeAsync(300)
    })
    thirdVisible = false
    await act(async () => {
      viewport.dispatchEvent(new dom.window.Event('scroll'))
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(onRead.mock.calls).toEqual([['1']])
    thirdVisible = true
    await act(async () => {
      viewport.dispatchEvent(new dom.window.Event('scroll'))
      await vi.advanceTimersByTimeAsync(800)
    })
    expect(onRead.mock.calls).toEqual([['1'], ['3']])
    await act(async () => {
      viewport.dispatchEvent(new dom.window.Event('scroll'))
      await vi.advanceTimersByTimeAsync(800)
    })
    expect(onRead).toHaveBeenCalledTimes(2)
  })

  it('requires a fresh dwell after the document becomes hidden', async () => {
    const onRead = vi.fn()
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    vi.spyOn(dom.window.HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      rectangle(0, 500),
    )
    const rows = [{ ...message('1'), senderId: bob.id }]
    function Harness() {
      const ref = useRef<HTMLDivElement>(null)
      useVisibleReads(ref, rows, alice.id, chat.id, '0', onRead)
      return (
        <div ref={ref}>
          <div data-message-id={rows[0].id} />
        </div>
      )
    }
    await act(async () => root.render(<Harness />))
    await act(async () => vi.advanceTimersByTimeAsync(300))
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      document.dispatchEvent(new dom.window.Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(onRead).not.toHaveBeenCalled()
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
      document.dispatchEvent(new dom.window.Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(699)
    })
    expect(onRead).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(onRead).toHaveBeenCalledExactlyOnceWith('1')
  })

  it('preserves continuous dwell while incoming messages rerender the chat', async () => {
    const onRead = vi.fn()
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    vi.spyOn(dom.window.HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        return this.hasAttribute('data-scroller') ? rectangle(0, 600) : rectangle(100, 200)
      },
    )
    function Harness({ count }: { count: number }) {
      const ref = useRef<HTMLDivElement>(null)
      const rows = Array.from({ length: count }, (_, index) => ({
        ...message(String(index + 1)),
        senderId: bob.id,
      }))
      useVisibleReads(ref, rows, alice.id, chat.id, '0', onRead)
      return (
        <div ref={ref} data-scroller>
          {rows.map((row) => (
            <div key={row.id} data-message-id={row.id}>
              {row.body}
            </div>
          ))}
        </div>
      )
    }
    await act(async () => root.render(<Harness count={1} />))
    for (let count = 2; count <= 6; count += 1) {
      await act(async () => vi.advanceTimersByTimeAsync(400))
      await act(async () => root.render(<Harness count={count} />))
      if (count === 3) expect(onRead).toHaveBeenCalledWith('1')
    }
    expect(onRead.mock.calls.flat()).toContain('4')
  })
})

describe('selected conversation features', () => {
  function setup(latest: Message[] = [message('1000000')]) {
    const fail = vi.fn()
    const recovery = connectedRecovery({
      latest: async () => ({ messages: latest }),
      older: async () => ({ messages: [] }),
      after: async () => ({ messages: [], nextSequence: '1000000', hasMore: false }),
    }).recovery
    const service = {
      delete: vi.fn(
        async (
          _id: string,
          requestId: string,
          scope: 'SELF' | 'EVERYONE',
          target: 'MESSAGES' | 'HISTORY' | 'CHAT',
        ) => ({
          operationId: requestId,
          scope,
          target,
          clearedThroughSequence: '0',
          seq: '1',
          visibilitySeq: '1',
          state: 'COMPLETED' as const,
          deletedRows: '1',
        }),
      ),
      reads: vi.fn(async () => ({
        throughSequence: '0',
        maxOtherReadSequence: '0',
        serverTime: new Date().toISOString(),
      })),
      advanceRead: vi.fn(async (_id: string, throughSequence: string) => ({
        throughSequence,
        readAt: new Date().toISOString(),
        serverTime: new Date().toISOString(),
      })),
      aroundMessage: vi.fn(async () => ({
        messages: [message('1')],
        anchorMessageId: 'message-1',
        seq: '0',
        hasOlder: false,
        hasNewer: true,
      })),
    }
    const send = vi.fn<(frame: OutgoingSocketFrame) => void>()
    let features!: ReturnType<typeof useConversationFeatures>
    function Harness({
      connected = true,
      selected = chat,
    }: {
      connected?: boolean
      selected?: Chat
    }) {
      features = useConversationFeatures({
        chat: selected,
        connected,
        sessionApi: service as unknown as ReturnType<typeof api.forSession>,
        recovery,
        send,
        remove: vi.fn(),
        fail,
      })
      return null
    }
    return { Harness, get: () => features, service, send, recovery, fail }
  }
  it('retains the deletion request identity after an uncertain response and bounds selected messages', async () => {
    const fixture = setup()
    fixture.service.delete.mockRejectedValueOnce(new Error('Connection lost'))
    await act(async () => root.render(<fixture.Harness />))
    await act(async () => {
      await expect(fixture.get().deleteMessages([message('1')], 'SELF')).rejects.toThrow(
        'Connection lost',
      )
    })
    await act(async () => fixture.get().deleteMessages([message('1')], 'SELF'))
    expect(fixture.service.delete).toHaveBeenCalledTimes(2)
    expect(fixture.service.delete.mock.calls[0]).toEqual(fixture.service.delete.mock.calls[1])
    expect(fixture.service.delete.mock.calls[1]).toMatchObject([
      'chat',
      expect.any(String),
      'SELF',
      'MESSAGES',
      ['message-1'],
    ])
    await expect(
      fixture.get().deleteMessages(
        Array.from({ length: 101 }, (_, index) => message(String(index + 1))),
        'EVERYONE',
      ),
    ).rejects.toThrow('Choose up to 100')
    await expect(
      fixture.get().deleteMessages([{ ...message('2'), chatId: 'other' }], 'SELF'),
    ).rejects.toThrow('Choose up to 100')
    expect(fixture.service.delete).toHaveBeenCalledTimes(2)
    fixture.recovery.dispose()
  })
  it('resolves an uncached million-sequence reply with one request and emits no human read-through', async () => {
    const fixture = setup()
    await fixture.recovery.catchUp('chat', true)
    await act(async () => root.render(<fixture.Harness />))
    await act(async () => {
      await fixture.get().jumpToMessage('message-1', true)
    })
    expect(fixture.service.aroundMessage).toHaveBeenCalledExactlyOnceWith('chat', 'message-1')
    expect(fixture.recovery.visibleWindows().chat.map((row) => row.sequence)).toEqual(['1'])
    expect(fixture.get().reveal).toMatchObject({ messageId: 'message-1', focus: true })
    expect(fixture.service.advanceRead).not.toHaveBeenCalled()
    await act(async () => {
      await fixture.get().jumpToMessage('message-1', false)
    })
    expect(fixture.service.aroundMessage).toHaveBeenCalledTimes(1)
    fixture.recovery.dispose()
  })
  it('shows a quote as unavailable when its message is gone instead of reporting an error', async () => {
    const reply = {
      ...message('2'),
      replyToMessageId: 'message-gone',
      replySenderId: bob.id,
      replyBody: 'deleted a moment ago',
      replyDeleted: false,
      replyVersion: '1',
    }
    const fixture = setup([reply])
    fixture.service.aroundMessage.mockRejectedValueOnce(new ApiError(404, 'Not found'))
    await fixture.recovery.catchUp('chat', true)
    await act(async () => root.render(<fixture.Harness />))
    await act(async () => {
      await fixture.get().jumpToMessage('message-gone', true)
    })
    expect(fixture.fail).not.toHaveBeenCalled()
    expect(fixture.recovery.visibleWindows().chat[0]).toMatchObject({
      replyToMessageId: 'message-gone',
      replyBody: null,
      replySenderId: null,
    })
    fixture.recovery.dispose()
  })
  it('retries a failed cumulative read after reconnect without inferring read from received history', async () => {
    const fixture = setup()
    fixture.service.advanceRead.mockRejectedValueOnce(new Error('offline'))
    await act(async () => root.render(<fixture.Harness />))
    expect(fixture.service.advanceRead).not.toHaveBeenCalled()
    await act(async () => fixture.get().readThrough('20'))
    expect(fixture.service.advanceRead).toHaveBeenCalledExactlyOnceWith('chat', '20')
    await act(async () => root.render(<fixture.Harness connected={false} />))
    await act(async () => root.render(<fixture.Harness connected />))
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(fixture.service.advanceRead).toHaveBeenCalledTimes(2)
    expect(fixture.get().summary.throughSequence).toBe('20')
    fixture.recovery.dispose()
  })

  it('coalesces a busy foreground chat to one cumulative read per second and cancels deferred work on selection change', async () => {
    const fixture = setup()
    await act(async () => root.render(<fixture.Harness />))
    await act(async () => fixture.get().readThrough('1'))
    for (const sequence of ['2', '3', '4', '5']) {
      await act(async () => vi.advanceTimersByTimeAsync(200))
      await act(async () => fixture.get().readThrough(sequence))
    }
    expect(fixture.service.advanceRead.mock.calls).toEqual([['chat', '1']])
    await act(async () => vi.advanceTimersByTimeAsync(200))
    expect(fixture.service.advanceRead.mock.calls).toEqual([
      ['chat', '1'],
      ['chat', '5'],
    ])
    await act(async () => fixture.get().readThrough('6'))
    await act(async () => root.render(<fixture.Harness selected={{ ...chat, id: 'other-chat' }} />))
    await act(async () => vi.advanceTimersByTimeAsync(2000))
    expect(fixture.service.advanceRead).toHaveBeenCalledTimes(2)
    fixture.recovery.dispose()
  })
})
