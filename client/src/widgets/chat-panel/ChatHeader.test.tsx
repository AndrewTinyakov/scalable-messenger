import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Chat } from '../../entities/chat/model'
import { ChatKind } from '../../shared/api/generated/socket-vocabulary'
import type { PresenceStatus } from '../../shared/api/socket'
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

async function render(presence: Record<string, PresenceStatus['state']>) {
  await act(async () => {
    root.render(
      <ChatHeader chat={chat} currentUser={alice} presence={presence} onBack={() => {}} />,
    )
  })
  return container.querySelectorAll('.chat-header-info p')
}

it('reserves the status line before presence is known', async () => {
  const unknown = await render({})
  expect(unknown).toHaveLength(1)
  expect(unknown[0].textContent).toBe('')
  const offline = await render({ [bob.id]: 'offline' })
  expect(offline).toHaveLength(1)
  expect(offline[0].textContent).toBe('offline')
  const online = await render({ [bob.id]: 'online' })
  expect(online[0].className).toBe('online')
})
