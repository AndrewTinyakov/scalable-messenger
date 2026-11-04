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

async function render(chat: Chat, online = false) {
  const select = vi.fn()
  const menu = vi.fn()
  await act(async () =>
    root.render(
      <ChatRow
        chat={chat}
        userId={me.id}
        selected={false}
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
