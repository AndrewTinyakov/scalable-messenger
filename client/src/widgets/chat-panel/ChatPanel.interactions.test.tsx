import { JSDOM } from 'jsdom'
import { act, type ComponentProps } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Chat } from '../../entities/chat/model'
import type { Message, PendingSend } from '../../entities/message/model'
import type { ReadingLocation } from '../../entities/message/readingLocation'
import type { useConversationFeatures } from '../../features/conversation/useConversationFeatures'
import type { ChatPanel as ChatPanelComponent } from './ChatPanel'

const alice = { id: 'alice', username: 'Alice' }
const bob = { id: 'bob', username: 'Bob' }
const carol = { id: 'carol', username: 'Carol' }
const direct: Chat = {
  id: 'chat-a',
  kind: 'DIRECT',
  members: [alice, bob],
  memberCount: 2,
  lastSequence: '150',
}
const group: Chat = {
  ...direct,
  id: 'group',
  kind: 'GROUP',
  ownerId: carol.id,
  members: [alice, bob, carol],
  memberCount: 3,
}
const rows = (count: number, chatId = direct.id): Message[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `${chatId}-${index + 1}`,
    chatId,
    sequence: String(index + 1),
    senderId: bob.id,
    body: `Message ${index + 1}`,
    createdAt: new Date(Date.parse('2026-11-04T10:00:00Z') + index * 1000).toISOString(),
  }))
let dom: JSDOM
let root: Root
let container: HTMLDivElement
let ChatPanel: typeof ChatPanelComponent
let features: ReturnType<typeof useConversationFeatures>
let focused: boolean
let saved: Map<string, ReadingLocation>
let revision: number

function rectangle(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left: 100,
    right: 600,
    width: 500,
    x: 100,
    y: top,
    toJSON: () => ({}),
  }
}
beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  focused = false
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
  vi.spyOn(dom.window.HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.classList.contains('chat-body')) return rectangle(10, 300)
    const row = this.closest<HTMLElement>('[data-message-id]')
    if (!row) return rectangle(10, 180)
    const viewport = row.closest<HTMLElement>('.chat-body')!
    const index = [...viewport.querySelectorAll('[data-message-id]')].indexOf(row)
    return rectangle(10 + index * 60 - viewport.scrollTop, 60)
  })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return this.classList.contains('chat-body') ? 300 : 60
    },
  })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get() {
      return this.classList.contains('chat-body')
        ? this.querySelectorAll('[data-message-id]').length * 60
        : 60
    },
  })
  const tops = new WeakMap<HTMLElement, number>()
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get() {
      return tops.get(this) ?? 0
    },
    set(value: number) {
      tops.set(this, Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)))
    },
  })
  features = {
    summary: { throughSequence: '0', maxOtherReadSequence: '0' },
    presence: {},
    reveal: null,
    jumpLoading: null,
    readThrough: vi.fn(),
    editMessage: vi.fn(),
    deleteMessages: vi.fn(async () => {}),
    clearHistory: vi.fn(async () => {}),
    deleteChat: vi.fn(async () => {}),
    jumpToMessage: vi.fn(),
    readers: vi.fn(async () => ({
      readers: [{ userId: bob.id, username: bob.username, readAt: '2026-11-04T10:01:00Z' }],
      nextUserId: null,
      detailsAvailable: true,
      serverTime: '2026-11-04T10:02:00Z',
      detailsExpiresAt: '2026-11-11T10:00:00Z',
    })),
  } as unknown as ReturnType<typeof useConversationFeatures>
  saved = new Map()
  revision = 0
  container = document.createElement('div')
  document.body.append(container)
  const { createRoot } = await import('react-dom/client')
  ChatPanel = (await import('./ChatPanel')).ChatPanel
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  vi.useRealTimers()
  dom.window.close()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
async function render(
  messages = rows(10),
  chat = direct,
  overrides: Partial<ComponentProps<typeof ChatPanel>> = {},
) {
  await act(async () =>
    root.render(
      <ChatPanel
        chat={chat}
        currentUser={alice}
        messages={messages}
        pending={[]}
        features={features}
        connection="connected"
        onSend={() => true}
        onRetry={() => {}}
        onBack={() => {}}
        hasOlder={false}
        hasNewer={false}
        hasUnresolvedGap={false}
        loadingOlder={false}
        loadingNewer={false}
        onLoadOlder={() => {}}
        onLoadNewer={() => {}}
        onJumpToLatest={() => {}}
        jumpRevision={0}
        onViewPositionChange={() => {}}
        {...overrides}
        readingLocation={saved.get(chat.id)}
        locationRevision={revision}
        onLocationChange={(chatId, location) => saved.set(chatId, location)}
      />,
    ),
  )
}
async function click(element: HTMLElement) {
  await act(async () => element.click())
}
function button(text: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (entry) => entry.textContent === text,
  )
  expect(found, `button ${text}`).toBeDefined()
  return found!
}
async function rightClick(target: HTMLElement) {
  await act(async () =>
    target.dispatchEvent(
      new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }),
    ),
  )
}
async function open(index = 0) {
  await rightClick(container.querySelectorAll<HTMLElement>('.message-bubble')[index])
}
async function select(index = 0) {
  await open(index)
  await click(button('Select'))
}
async function pointer(kind: string, target: HTMLElement, y: number, x = 5) {
  await act(async () => {
    const event = new dom.window.MouseEvent(kind, {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: ['pointerdown', 'pointermove'].includes(kind) ? 1 : 0,
      clientY: y,
      clientX: x,
    })
    Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: 'mouse' } })
    target.dispatchEvent(event)
  })
}
function selectedIds() {
  return [...container.querySelectorAll<HTMLElement>('[aria-checked="true"]')].map(
    (row) => row.dataset.messageId,
  )
}

describe('message actions and scoped deletion', () => {
  it('replaces the browser context menu with message actions without selecting messages', async () => {
    await render(rows(2))
    const target = container.querySelector<HTMLElement>('.message-text')!
    const event = new dom.window.MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
    })
    await act(async () => target.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(true)
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Selected messages"]')).toBeNull()
  })

  it('opens relevant actions on right click, loads own read times inline and shows a single read status', async () => {
    const messages = rows(2).map((row) => ({ ...row, senderId: alice.id }))
    features.summary.maxOtherReadSequence = '1'
    await render(messages)
    expect(container.querySelectorAll('.lucide-check-check')).toHaveLength(1)
    expect(container.querySelectorAll('.lucide-check')).toHaveLength(1)
    expect(container.querySelector('.message-action-trigger, .read-receipt')).toBeNull()
    await open()
    expect(document.querySelector('[role="menu"]')?.textContent).toBe('ReplyEditCopySelectDelete')
    expect(document.querySelector('.inline-readers time')?.getAttribute('datetime')).toBe(
      '2026-11-04T10:01:00Z',
    )
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await click(button('Copy'))
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not copy')
  })

  it('defaults to self scope and submits incoming direct messages for everyone only after explicit choice', async () => {
    const messages = rows(1)
    await render(messages)
    await open()
    expect(document.querySelector('[role="menu"]')?.textContent).toBe('ReplyCopySelectDelete')
    expect(features.readers).not.toHaveBeenCalled()
    await click(button('Delete'))
    expect((document.querySelector('input[value="SELF"]') as HTMLInputElement).checked).toBe(true)
    expect(features.deleteMessages).not.toHaveBeenCalled()
    await click(document.querySelector<HTMLInputElement>('input[value="EVERYONE"]')!)
    await click(button('Delete for everyone'))
    expect(features.deleteMessages).toHaveBeenCalledExactlyOnceWith(messages, 'EVERYONE')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('keeps self clear/delete available to ordinary group members and limits global selected scope to own messages', async () => {
    await render(rows(2, group.id), group)
    await click(container.querySelector('[aria-label="Chat actions"]')!)
    await click(button('Clear history'))
    expect(document.querySelector('input[value="EVERYONE"]')).toBeNull()
    await click(button('Clear for me'))
    expect(features.clearHistory).toHaveBeenCalledExactlyOnceWith('SELF')
    await click(container.querySelector('[aria-label="Chat actions"]')!)
    await click(button('Delete chat'))
    expect(document.querySelector('input[value="EVERYONE"]')).toBeNull()
    await click(button('Delete for me'))
    expect(features.deleteChat).toHaveBeenCalledExactlyOnceWith('SELF')
    await select()
    await click(button('Delete'))
    expect(document.querySelector('input[value="EVERYONE"]')).toBeNull()
  })

  it('clears a copied reply after authoritative removal without confusing window eviction with deletion', async () => {
    const messages = rows(10)
    const resolve = vi.fn().mockResolvedValue(messages[9])
    features.resolveTarget = resolve
    features.revisionKey = '0:0'
    await render(messages)
    await act(async () => {
      container
        .querySelectorAll('.message-text')[9]
        .dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true, detail: 2 }))
    })
    expect(container.querySelector('.composer-mode')?.textContent).toContain('Message 10')
    await render(messages.slice(0, 5))
    expect(container.querySelector('.composer-mode')?.textContent).toContain('Message 10')
    resolve.mockResolvedValueOnce(undefined)
    features.revisionKey = '0:1'
    await render(messages.slice(0, 5))
    expect(container.querySelector('.composer-mode')).toBeNull()
    expect(container.textContent).toContain('This message is no longer available.')
  })

  it('replies on bubble and body double click and suppresses reply after a selection drag', async () => {
    await render(rows(2))
    const bubble = container.querySelector<HTMLElement>('.message-bubble')!
    await act(async () =>
      bubble.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true, detail: 2 })),
    )
    expect(container.querySelector('.composer-mode')?.textContent).toContain('Message 1')
    await click(container.querySelector('[aria-label="Cancel reply"]')!)
    await act(async () =>
      bubble
        .querySelector('.message-text')!
        .dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true, detail: 2 })),
    )
    expect(container.querySelector('.composer-mode')?.textContent).toContain('Message 1')
    await click(container.querySelector('[aria-label="Cancel reply"]')!)
    await pointer('pointerdown', bubble, 30, 150)
    await pointer('pointermove', bubble, 50, 200)
    await pointer('pointerup', bubble, 50, 200)
    await act(async () =>
      bubble.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true, detail: 2 })),
    )
    expect(container.querySelector('.composer-mode')).toBeNull()
    expect(container.querySelector('[aria-label="Selected messages"]')).not.toBeNull()
    await act(async () =>
      bubble.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true, detail: 2 })),
    )
    expect(container.querySelector('.composer-mode')).toBeNull()
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })
})

describe('keyboard', () => {
  async function escape() {
    await act(async () =>
      document.body.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }),
      ),
    )
  }

  it('leaves select mode first and the chat on the next Escape', async () => {
    const back = vi.fn()
    await render(rows(4), direct, { onBack: back })
    await select(0)
    await escape()
    expect(container.querySelector('[aria-label="Selected messages"]')).toBeNull()
    expect(back).not.toHaveBeenCalled()
    await escape()
    expect(back).toHaveBeenCalledOnce()
  })

  it('cancels a reply before leaving the chat and leaves a dialog to itself', async () => {
    const back = vi.fn()
    await render(rows(4), direct, { onBack: back })
    await open(1)
    await click(button('Reply'))
    await escape()
    expect(container.querySelector('.composer-mode')).toBeNull()
    expect(back).not.toHaveBeenCalled()
    await open(1)
    await click(button('Delete'))
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    await escape()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(back).not.toHaveBeenCalled()
  })
})

describe('direct chat presentation', () => {
  it('shows the peer avatar on the last incoming message of a run only', async () => {
    const incoming = rows(3).map((row) => ({ ...row, senderId: bob.id }))
    await render(incoming)
    const avatars = [...container.querySelectorAll('.message-avatar')]
    expect(avatars.map((item) => item.classList.contains('avatar-spacer'))).toEqual([
      true,
      true,
      false,
    ])
    expect(container.querySelector('.message-sender')).toBeNull()
  })

  it('shows what a pending reply is replying to', async () => {
    const messages = rows(2).map((row) => ({ ...row, senderId: bob.id }))
    const send = {
      requestId: '01ARZ3NDEKTSV4RRFFQ69G5FB0',
      chatId: direct.id,
      body: 'answer',
      replyToMessageId: messages[0].id,
      status: 'queued',
      createdAt: '2026-11-04T10:30:00Z',
    } as PendingSend
    await render(messages, direct, { pending: [send] })
    const quote = container.querySelector('.message-row.mine .message-quote')
    expect(quote?.textContent).toContain(bob.username)
    expect(quote?.textContent).toContain(messages[0].body)
  })
})

describe('sending while reading history', () => {
  async function submit(text: string) {
    const input = container.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        text,
      )
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    await act(async () =>
      input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    )
  }

  it('returns to the latest messages after a send from an older window', async () => {
    const jump = vi.fn()
    await render(rows(4), direct, { hasNewer: true, onJumpToLatest: jump })
    const viewport = container.querySelector<HTMLElement>('.chat-body')!
    Object.defineProperty(viewport, 'scrollHeight', { value: 2000, configurable: true })
    viewport.scrollTop = 100
    await submit('hello')
    expect(jump).toHaveBeenCalledOnce()
    expect(viewport.scrollTop).toBe(2000 - viewport.clientHeight)
  })

  it('stays where it is when the send is refused', async () => {
    const jump = vi.fn()
    await render(rows(4), direct, { hasNewer: true, onJumpToLatest: jump, onSend: () => false })
    await submit('hello')
    expect(jump).not.toHaveBeenCalled()
  })
})

describe('list selection', () => {
  it('starts selection by dragging a message without entering select mode first', async () => {
    await render(rows(8))
    const viewport = container.querySelector<HTMLElement>('.chat-body')!
    viewport.scrollTop = 0
    const elements = container.querySelectorAll<HTMLElement>('[data-message-id]')
    await pointer('pointerdown', elements[1].querySelector('.message-text')!, 100, 150)
    expect(container.querySelector('[aria-label="Selected messages"]')).toBeNull()
    await pointer('pointermove', viewport, 220)
    await pointer('pointerup', viewport, 220)
    expect(selectedIds()).toEqual(['chat-a-2', 'chat-a-3', 'chat-a-4'])
    expect(container.querySelector('[aria-label="Selected messages"]')).not.toBeNull()
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('leaves select mode when the last selected message is deselected', async () => {
    await render(rows(4))
    await select(0)
    const first = container.querySelector<HTMLElement>('[data-message-id]')!
    await pointer('pointerdown', first, 30)
    await pointer('pointerup', first, 30)
    expect(selectedIds()).toEqual([])
    expect(container.querySelector('[aria-label="Selected messages"]')).toBeNull()
    expect(container.querySelector('.chat-composer-region')?.hasAttribute('hidden')).toBe(false)
  })

  it('stays in select mode while a drag passes through zero and exits when it ends empty', async () => {
    await render(rows(4))
    await select(0)
    const viewport = container.querySelector<HTMLElement>('.chat-body')!
    const first = container.querySelector<HTMLElement>('[data-message-id]')!
    await pointer('pointerdown', first, 30)
    expect(selectedIds()).toEqual([])
    expect(container.querySelector('[aria-label="Selected messages"]')).not.toBeNull()
    await pointer('pointermove', viewport, 60)
    await pointer('pointermove', viewport, 30)
    await pointer('pointerup', viewport, 30)
    expect(selectedIds()).toEqual([])
    expect(container.querySelector('[aria-label="Selected messages"]')).toBeNull()
  })

  it('opens actions only by right click on the bubble and cancels an automatically started drag', async () => {
    await render(rows(5))
    const first = container.querySelector<HTMLElement>('[data-message-id]')!
    await pointer('pointerdown', first, 30, 150)
    await pointer('pointerup', first, 30, 150)
    await click(first.querySelector('time')!)
    expect(document.querySelector('[role="menu"]')).toBeNull()
    await rightClick(first)
    expect(document.querySelector('[role="menu"]')).toBeNull()
    await rightClick(first.querySelector<HTMLElement>('.message-bubble')!)
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    await act(async () =>
      document.body.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true })),
    )
    await pointer('pointerdown', first.querySelector('.message-text')!, 30, 150)
    await pointer('pointermove', document.body, 160, 5)
    expect(selectedIds()).toHaveLength(3)
    await pointer('pointercancel', document.body, 160, 5)
    expect(selectedIds()).toHaveLength(0)
    expect(container.querySelector('[aria-label="Selected messages"]')).toBeNull()
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('selects and deselects a vertical range outside bubble X, reverses without toggling intent, and suppresses trailing click', async () => {
    await render(rows(6))
    await select(0)
    const viewport = container.querySelector<HTMLElement>('.chat-body')!
    viewport.scrollTop = 0
    const elements = [...container.querySelectorAll<HTMLElement>('[data-message-id]')]
    await pointer('pointerdown', elements[1], 100)
    await pointer('pointermove', viewport, 220)
    expect(selectedIds()).toEqual(['chat-a-1', 'chat-a-2', 'chat-a-3', 'chat-a-4'])
    await pointer('pointermove', viewport, 110)
    expect(selectedIds()).toEqual(['chat-a-1', 'chat-a-2'])
    await pointer('pointermove', viewport, 220)
    await pointer('pointerup', viewport, 220)
    await act(async () =>
      elements[3].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, detail: 1 })),
    )
    expect(selectedIds()).toHaveLength(4)
    await pointer('pointerdown', elements[1], 100)
    await pointer('pointermove', viewport, 220)
    expect(selectedIds()).toEqual(['chat-a-1'])
    await pointer('pointercancel', viewport, 220)
    expect(selectedIds()).toHaveLength(4)
    await pointer('pointerdown', elements[1], 100)
    await pointer('pointermove', viewport, 220)
    await pointer('pointerup', viewport, 220)
    expect(selectedIds()).toEqual(['chat-a-1'])
  })

  it('bounds selection at 100 and scrolls only while the owned gesture is active', async () => {
    vi.useFakeTimers()
    await render(rows(150))
    await select()
    const viewport = container.querySelector<HTMLElement>('.chat-body')!
    viewport.scrollTop = 0
    const first = container.querySelector<HTMLElement>('[data-message-id]')!
    await pointer('pointerdown', first, 40)
    await pointer('pointermove', viewport, 9000)
    expect(selectedIds()).toHaveLength(0)
    await pointer('pointercancel', viewport, 9000)
    expect(selectedIds()).toHaveLength(1)
    const second = container.querySelectorAll<HTMLElement>('[data-message-id]')[1]
    await pointer('pointerdown', second, 100)
    await pointer('pointermove', viewport, 9000)
    expect(selectedIds()).toHaveLength(100)
    await act(async () => vi.advanceTimersByTimeAsync(100))
    expect(viewport.scrollTop).toBeGreaterThan(0)
    expect(viewport.scrollTop).toBeLessThanOrEqual(126)
    await pointer('pointerup', viewport, 9000)
    const stopped = viewport.scrollTop
    await act(async () => vi.advanceTimersByTimeAsync(300))
    expect(viewport.scrollTop).toBe(stopped)
    expect(container.querySelector('[aria-label="Selected messages"]')?.textContent).toContain(
      '100 messages',
    )
    await click(button('Delete'))
    await click(button('Delete for me'))
    expect(features.deleteMessages).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'chat-a-100' })]),
      'SELF',
    )
    expect(vi.mocked(features.deleteMessages).mock.calls[0][0]).toHaveLength(100)
  })

  it('supports keyboard toggles and cancels selection with Escape', async () => {
    await render(rows(2))
    const textarea = container.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        'Draft before selection',
      )
      textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    const first = container.querySelector<HTMLElement>('[data-message-id]')!
    await act(async () =>
      first.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    )
    expect(document.activeElement?.textContent).toBe('Reply')
    await click(button('Select'))
    const second = container.querySelectorAll<HTMLElement>('[data-message-id]')[1]
    await act(async () =>
      second.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true })),
    )
    expect(selectedIds()).toHaveLength(2)
    await act(async () =>
      second.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    )
    expect(container.querySelector('[aria-label="Selected messages"]')).toBeNull()
    expect(container.querySelector('textarea')).toBe(textarea)
    expect(textarea.value).toBe('Draft before selection')
  })
})

describe('viewport and run geometry', () => {
  it('preserves a pixel offset across A/B/A and waits for an evicted anchor before starting reads', async () => {
    const a = rows(100)
    await render(a)
    const viewport = container.querySelector<HTMLElement>('.chat-body')!
    viewport.scrollTop = 1234
    await act(async () => viewport.dispatchEvent(new dom.window.Event('scroll')))
    const bookmark = { ...saved.get(direct.id)! }
    expect(bookmark).toMatchObject({
      messageId: 'chat-a-21',
      sequence: '21',
      offsetPx: -34,
      atLatest: false,
    })
    const b = { ...direct, id: 'chat-b' }
    await render(rows(20, b.id), b)
    await render(a)
    expect(viewport.scrollTop).toBe(1234)
    expect(saved.get(direct.id)).toEqual(bookmark)
    await render(rows(20, b.id), b)
    await render(a.slice(50))
    vi.useFakeTimers()
    focused = true
    await act(async () => {
      window.dispatchEvent(new dom.window.Event('focus'))
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(features.readThrough).not.toHaveBeenCalled()
    revision += 1
    await render(a.slice(15, 45))
    expect(viewport.scrollTop).toBe(334)
    await act(async () => vi.advanceTimersByTimeAsync(700))
    expect(features.readThrough).toHaveBeenCalled()
  })

  it('uses focus alone after a background burst and requires fresh 700ms dwell', async () => {
    vi.useFakeTimers()
    await render(rows(1))
    await act(async () => vi.advanceTimersByTimeAsync(2000))
    await render(rows(100))
    await act(async () => vi.advanceTimersByTimeAsync(2000))
    expect(features.readThrough).not.toHaveBeenCalled()
    focused = true
    await act(async () => {
      window.dispatchEvent(new dom.window.Event('focus'))
      await vi.advanceTimersByTimeAsync(699)
    })
    expect(features.readThrough).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(features.readThrough).toHaveBeenLastCalledWith('100')
    expect(
      vi.mocked(features.readThrough).mock.calls.every(([sequence]) => Number(sequence) >= 96),
    ).toBe(true)
  })

  it('puts the incoming sender at run start and avatar/tail at run end, splitting at ten minutes and day boundaries but not on clock skew', async () => {
    const messages = rows(6, group.id).map((row, index) => ({
      ...row,
      createdAt: [
        '2026-11-03T23:59:00',
        '2026-11-04T00:00:00',
        '2026-11-04T00:09:59.999',
        '2026-11-04T00:19:59.999',
        '2026-11-04T00:19:00',
        '2026-11-04T00:20:00',
      ][index],
    }))
    await render(messages, group)
    const elements = [...container.querySelectorAll<HTMLElement>('[data-message-id]')]
    expect(elements.map((row) => row.classList.contains('run-start'))).toEqual([
      true,
      true,
      false,
      true,
      false,
      false,
    ])
    expect(elements.map((row) => row.classList.contains('run-end'))).toEqual([
      true,
      false,
      true,
      false,
      false,
      true,
    ])
    expect(elements.map((row) => Boolean(row.querySelector('.message-sender')))).toEqual([
      true,
      true,
      false,
      true,
      false,
      false,
    ])
    expect(
      elements.map((row) =>
        row.querySelector('.message-avatar')?.classList.contains('avatar-spacer'),
      ),
    ).toEqual([false, true, false, true, true, false])
  })
})
