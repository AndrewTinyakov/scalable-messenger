import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Chat } from '../../entities/chat/model'
import { PresenceStore } from '../../features/presence/presenceStore'
import { PresenceContext } from '../../features/presence/usePresence'
import { ChatKind } from '../../shared/api/generated/socket-vocabulary'
import { ChatHeader } from './ChatHeader'

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
let dom: JSDOM
let root: Root
let container: HTMLDivElement

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>')
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  dom.window.close()
  vi.unstubAllGlobals()
})

async function render(store: PresenceStore, shown: Chat = chat) {
  await act(async () => {
    root.render(
      <PresenceContext.Provider value={store}>
        <ChatHeader chat={shown} currentUser={alice} onBack={() => {}} onMembers={() => {}} />
      </PresenceContext.Provider>,
    )
  })
  return container.querySelector('.chat-header-info p, .chat-header-info button')!
}

it('shows the peer status, never a blank line once it is known', async () => {
  const store = new PresenceStore()
  const sent: unknown[] = []
  store.connect((frame) => sent.push(frame))
  const line = () => container.querySelector('.chat-header-info p')!
  await render(store)
  expect(line().textContent).toBe('')
  await act(async () => {
    store.onEvent({ type: 'presence', version: 1, statuses: [{ userId: bob.id, online: true }] })
  })
  expect(line().textContent).toBe('online')
  expect(line().className).toBe('online')
  await act(async () => {
    store.onEvent({ type: 'presence', version: 1, statuses: [], unavailable: [bob.id] })
  })
  expect(line().textContent).toBe('last seen recently')
})

it('shows a live online count for small groups and opens members from it', async () => {
  const store = new PresenceStore()
  const sent: { type: string; chatId?: string }[] = []
  store.connect((frame) => sent.push(frame))
  const group: Chat = { ...chat, kind: ChatKind.GROUP, name: 'Team', memberCount: 3 }
  const line = await render(store, group)
  expect(sent.at(-1)).toEqual({ type: 'watch_online_count', version: 1, chatId: group.id })
  await act(async () => {
    store.onEvent({ type: 'online_count', version: 1, chatId: group.id, online: 2, members: 3 })
  })
  expect(line.textContent).toBe('3 members, 2 online')
  expect(line.tagName).toBe('BUTTON')
  const large = await render(store, {
    ...group,
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAY',
    memberCount: 201,
  })
  expect(large.textContent).toBe('201 members')
  expect(sent.at(-1)).toEqual({ type: 'watch_online_count', version: 1 })
})

it('previews paginated members with live status while hovering the count', async () => {
  vi.useFakeTimers()
  const store = new PresenceStore()
  store.connect(() => {})
  const group: Chat = {
    ...chat,
    kind: ChatKind.GROUP,
    name: 'Team',
    memberCount: 2,
    ownerId: alice.id,
  }
  const load = vi.fn(async () => ({ members: [alice, bob], nextCursor: null }))
  await act(async () => {
    root.render(
      <PresenceContext.Provider value={store}>
        <ChatHeader
          chat={group}
          currentUser={alice}
          onBack={() => {}}
          onMembers={() => {}}
          loadMembers={load}
        />
      </PresenceContext.Provider>,
    )
  })
  const count = container.querySelector('.chat-header-members')!
  await act(async () => {
    count.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(300)
  })
  expect(load).toHaveBeenCalledWith(group.id, undefined)
  await act(async () => {
    store.onEvent({ type: 'presence', version: 1, statuses: [{ userId: bob.id, online: true }] })
  })
  const rows = [...container.querySelectorAll('.members-preview li')].map((row) => row.textContent)
  expect(rows).toEqual([expect.stringContaining('owner'), 'Bbobonline'])
  await act(async () => {
    count.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(200)
  })
  expect(container.querySelector('.members-preview')).toBeNull()
  vi.useRealTimers()
})
