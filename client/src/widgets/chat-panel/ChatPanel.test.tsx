import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Chat } from '../../entities/chat/model'
import type { Message, PendingSend } from '../../entities/message/model'
import type { User } from '../../entities/session/model'
import { ChatKind } from '../../shared/api/generated/socket-vocabulary'
import { ChatPanel } from './ChatPanel'

const alice = { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', username: 'alice' }
const bob = { id: '01ARZ3NDEKTSV4RRFFQ69G5FAW', username: 'bob' }
const chat: Chat = {
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAX',
  kind: ChatKind.DIRECT,
  members: [alice, bob],
  memberCount: 2,
  lastSequence: '1',
  name: null,
}
const send: PendingSend = {
  chatId: chat.id,
  requestId: '01ARZ3NDEKTSV4RRFFQ69G5FAY',
  body: 'Hello Bob',
  createdAt: '2026-11-01T10:00:59Z',
  status: 'sending',
}
const message: Message = {
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAZ',
  chatId: chat.id,
  sequence: '1',
  senderId: alice.id,
  body: send.body,
  createdAt: '2026-11-01T10:01:00Z',
}
let dom: JSDOM
let root: Root
let container: HTMLDivElement
let lookupUser: ((id: string) => Promise<User>) | undefined

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>')
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  lookupUser = undefined
})
afterEach(async () => {
  await act(async () => root.unmount())
  dom.window.close()
  vi.unstubAllGlobals()
})

async function render(pending: PendingSend[], messages: Message[] = [], selected = chat) {
  await act(async () => {
    root.render(
      <ChatPanel
        chat={selected}
        currentUser={alice}
        messages={messages}
        pending={pending}
        connection="connected"
        onSend={() => true}
        onRetry={() => {}}
        onBack={() => {}}
        onNew={() => {}}
        lookupUser={lookupUser}
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
      />,
    )
  })
}

describe('outgoing message presentation', () => {
  it('keeps a former member name and the same message row when membership changes', async () => {
    const group = { ...chat, kind: ChatKind.GROUP }
    const received = { ...message, senderId: bob.id }
    await render([], [received], group)
    const row = container.querySelector('.message-row')
    const timestamp = container.querySelector('time')?.textContent
    await render([], [received], { ...group, members: [alice], memberCount: 1 })
    expect(container.querySelector('.message-sender')?.textContent).toBe('bob')
    expect(container.querySelector('.message-row')).toBe(row)
    expect(container.querySelector('time')?.textContent).toBe(timestamp)
  })

  it('resolves former members from history after reload and retries a failed lookup on metadata refresh', async () => {
    const group = { ...chat, kind: ChatKind.GROUP, members: [alice], memberCount: 1 }
    const received = { ...message, senderId: bob.id }
    const lookup = vi
      .fn<(id: string) => Promise<User>>()
      .mockRejectedValueOnce(new Error('Unavailable'))
      .mockResolvedValue(bob)
    lookupUser = lookup
    await render([], [received], group)
    const row = container.querySelector('.message-row')
    const timestamp = container.querySelector('time')?.textContent
    expect(container.querySelector('.message-sender')?.textContent).toBe('Member')
    await render([], [received], { ...group, members: [...group.members] })
    expect(lookup).toHaveBeenCalledTimes(2)
    expect(lookup).toHaveBeenLastCalledWith(bob.id)
    expect(container.querySelector('.message-sender')?.textContent).toBe('bob')
    expect(container.querySelector('.message-row')).toBe(row)
    expect(container.querySelector('time')?.textContent).toBe(timestamp)
  })
  it('keeps the same bubble and time from sending through queueing, save, and history arrival', async () => {
    await render([send])
    const row = container.querySelector('.message-row')
    const timestamp = container.querySelector('time')?.textContent
    expect(container.querySelector('[aria-label="Pending"]')).not.toBeNull()
    expect(container.querySelector('.lucide-clock-3, .lucide-clock3')).not.toBeNull()
    await render([{ ...send, status: 'queued' }])
    expect(container.querySelector('.message-row')).toBe(row)
    expect(container.querySelector('[aria-label="Pending"]')).not.toBeNull()
    const saved: PendingSend = { ...send, status: 'saved', messageId: message.id }
    await render([saved])
    expect(container.querySelector('.message-row')).toBe(row)
    expect(container.querySelector('[aria-label="Sent"] .lucide-check')).not.toBeNull()
    await render([saved], [message])
    expect(container.querySelectorAll('.message-row')).toHaveLength(1)
    expect(container.querySelector('.message-row')).toBe(row)
    expect(container.querySelector('time')?.textContent).toBe(timestamp)
    expect(container.querySelector('time')?.dateTime).toBe(send.createdAt)
    expect(container.querySelector('.send-state')?.textContent).toBe('')
    expect(container.querySelector('.lucide-check-check')).toBeNull()
  })

  it('keeps other pending draft messages visible when the first message creates the chat', async () => {
    const draft = { ...chat, id: `draft:${bob.id}` }
    const first = { ...send, chatId: draft.id, recipientId: bob.id }
    const second = { ...first, requestId: '01ARZ3NDEKTSV4RRFFQ69G5FB0', body: 'Another message' }
    await render([first, second], [], draft)
    const rows = [...container.querySelectorAll('.message-row')]
    const composer = container.querySelector('textarea')
    await render(
      [{ ...first, chatId: chat.id, messageId: message.id, status: 'saved' }, second],
      [message],
    )
    expect([...container.querySelectorAll('.message-row')]).toEqual(rows)
    expect(container.querySelector('textarea')).toBe(composer)
    expect(container.querySelector('[aria-label="Messages"]')?.textContent).toContain(
      'Another message',
    )
  })
})
