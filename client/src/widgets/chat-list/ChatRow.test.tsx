import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Chat } from '../../entities/chat/model'
import { ChatKind } from '../../shared/api/generated/socket-vocabulary'
import { ChatRow } from './ChatRow'

const me = { id: 'me', username: 'alice' }
const peer = { id: 'peer', username: 'bob' }
const direct: Chat = {
  id: 'direct',
  kind: ChatKind.DIRECT,
  members: [me, peer],
  memberCount: 2,
  lastSequence: '9',
  unreadCount: 0,
  unreadCountCapped: false,
  lastMessage: null,
}
const summary = {
  id: 'message',
  sequence: '9',
  senderId: 'peer',
  senderUsername: 'bob',
  createdAt: '2026-11-04T10:00:00Z',
  bodyPreview: 'line one\nline two',
  deleted: false,
}

let dom: JSDOM
let root: Root
let container: HTMLDivElement

async function render(chat: Chat, online = false, live = false) {
  const select = vi.fn()
  const menu = vi.fn()
  await act(async () =>
    root.render(
      <ChatRow
        chat={chat}
        userId={me.id}
        selected={false}
        live={live}
        online={online}
        onSelect={select}
        onMenu={menu}
      />,
    ),
  )
  return { row: container.querySelector<HTMLButtonElement>('.chat-item')!, select, menu }
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

describe('chat row', () => {
  it('shows a one-line preview without a sender in a direct chat', async () => {
    const { row } = await render({ ...direct, lastMessage: summary })
    expect(row.querySelector('.chat-preview')?.textContent).toBe('line one line two')
  })

  it('names the sender in groups and marks the account own messages', async () => {
    const group = { ...direct, kind: ChatKind.GROUP, name: 'Team', members: [] }
    const { row } = await render({ ...group, lastMessage: summary })
    expect(row.querySelector('.chat-preview-sender')?.textContent).toBe('bob: ')
    await render({ ...direct, lastMessage: { ...summary, senderId: me.id } })
    expect(row.querySelector('.chat-preview-sender')?.textContent).toBe('You: ')
  })

  it('renders exact, large and lower-bound unread counts', async () => {
    const { row } = await render({ ...direct, unreadCount: 7 })
    expect(row.querySelector('.unread-badge')?.textContent).toBe('7')
    await render({ ...direct, unreadCount: 250 })
    expect(row.querySelector('.unread-badge')?.textContent).toBe('99+')
    await render({ ...direct, unreadCount: 40, unreadCountCapped: true })
    expect(row.querySelector('.unread-badge')?.textContent).toBe('40+')
    await render({ ...direct, unreadCount: 0 })
    expect(row.querySelector('.unread-badge')).toBeNull()
  })

  it('hides the badge while the chat is being read live and restores it afterwards', async () => {
    const { row } = await render({ ...direct, unreadCount: 2 }, false, true)
    expect(row.querySelector('.unread-badge')).toBeNull()
    await render({ ...direct, unreadCount: 2 })
    expect(row.querySelector('.unread-badge')?.textContent).toBe('2')
  })

  it('shows the online dot only for an online peer', async () => {
    const { row } = await render(direct, true)
    expect(row.querySelector('.avatar-online')).not.toBeNull()
    await render(direct, false)
    expect(row.querySelector('.avatar-online')).toBeNull()
  })

  it('replaces the browser menu with chat options on right click and keeps left click for opening', async () => {
    const { row, select, menu } = await render(direct)
    const contextMenu = new dom.window.MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      detail: 1,
      clientX: 40,
      clientY: 60,
    })
    await act(async () => row.dispatchEvent(contextMenu))
    expect(contextMenu.defaultPrevented).toBe(true)
    expect(menu).toHaveBeenCalledWith(direct, row, false, { x: 40, y: 60 })
    expect(select).not.toHaveBeenCalled()
    await act(async () => row.click())
    expect(select).toHaveBeenCalledWith('direct')
  })

  it('opens chat options from the keyboard', async () => {
    const { row, menu } = await render(direct)
    await act(async () =>
      row.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }),
      ),
    )
    expect(menu).toHaveBeenCalledWith(direct, row, true)
  })
})

describe('chat row personal state and latest preview', () => {
  async function renderWith(chat: Chat, extra: Partial<Parameters<typeof ChatRow>[0]> = {}) {
    await act(async () =>
      root.render(
        <ChatRow
          chat={chat}
          userId={me.id}
          selected={false}
          online={false}
          onSelect={vi.fn()}
          onMenu={vi.fn()}
          {...extra}
        />,
      ),
    )
    return container.querySelector<HTMLButtonElement>('.chat-item')!
  }

  it('previews a loaded live message newer than the server summary', async () => {
    const row = await renderWith(
      { ...direct, lastMessage: summary },
      {
        loaded: {
          id: 'live',
          chatId: 'direct',
          sequence: '10',
          senderId: me.id,
          body: 'just arrived',
          createdAt: '2026-11-04T10:01:00Z',
        },
      },
    )
    expect(row.querySelector('.chat-preview')?.textContent).toBe('You: just arrived')
    expect(row.querySelector('[aria-label="Sent"]')).not.toBeNull()
  })

  it('previews an own send that is still waiting and its failure', async () => {
    const send = {
      chatId: 'direct',
      requestId: 'request',
      body: 'on its way',
      createdAt: '2026-11-04T10:02:00Z',
      status: 'sending' as const,
    }
    const row = await renderWith({ ...direct, lastMessage: summary }, { pending: send })
    expect(row.querySelector('.chat-preview')?.textContent).toBe('You: on its way')
    expect(row.querySelector('[aria-label="Sending"]')).not.toBeNull()
    await renderWith(
      { ...direct, lastMessage: summary },
      { pending: { ...send, status: 'rejected' } },
    )
    expect(row.querySelector('[aria-label="Not sent"]')).not.toBeNull()
  })

  it('ignores a loaded tombstone and an older pending send', async () => {
    const row = await renderWith(
      { ...direct, lastMessage: summary },
      {
        loaded: {
          id: 'gone',
          chatId: 'direct',
          sequence: '12',
          senderId: peer.id,
          body: '',
          createdAt: '2026-11-04T10:03:00Z',
          deletedAt: '2026-11-04T10:04:00Z',
        },
        pending: {
          chatId: 'direct',
          requestId: 'old',
          body: 'older',
          createdAt: '2026-11-04T09:00:00Z',
          status: 'queued',
        },
      },
    )
    expect(row.querySelector('.chat-preview')?.textContent).toBe('line one line two')
  })

  it('marks unread, muted and pinned chats', async () => {
    let row = await renderWith({ ...direct, markedUnread: true })
    expect(row.querySelector('.unread-mark')).not.toBeNull()
    row = await renderWith({ ...direct, unreadCount: 3, mutedForever: true })
    expect(row.querySelector('.unread-badge.muted')?.textContent).toBe('3')
    expect(row.querySelector('[aria-label="Muted"]')).not.toBeNull()
    row = await renderWith({ ...direct, mutedUntil: '2000-01-01T00:00:00Z', pinnedRank: 1 })
    expect(row.querySelector('[aria-label="Muted"]')).toBeNull()
    expect(row.querySelector('[aria-label="Pinned"]')).not.toBeNull()
    expect(row.getAttribute('draggable')).toBe('false')
  })
})
