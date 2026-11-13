import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Chat } from '../entities/chat/model'
import { ChatKind } from '../shared/api/generated/socket-vocabulary'
import type { OutgoingSocketFrame } from '../shared/api/socket'
import { useSidebarWatch } from './useSidebarWatch'

const alice = { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', username: 'alice' }
const bob = { id: '01ARZ3NDEKTSV4RRFFQ69G5FAW', username: 'bob' }
const direct: Chat = {
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAX',
  kind: ChatKind.DIRECT,
  members: [alice, bob],
  memberCount: 2,
  lastSequence: '1',
  name: null,
}
let dom: JSDOM
let root: Root
let watch: ReturnType<typeof useSidebarWatch>
let sent: OutgoingSocketFrame[]

function Harness({ selectedChat }: { selectedChat?: Chat }) {
  watch = useSidebarWatch({
    connectionGeneration: 1,
    connected: true,
    userId: alice.id,
    selectedChat,
    listChats: () => [],
    send: (frame) => sent.push(frame),
  })
  return null
}

beforeEach(() => {
  vi.useFakeTimers()
  dom = new JSDOM('<!doctype html><html><body></body></html>')
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  sent = []
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  dom.window.close()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('accepts presence for a selected direct chat that the chat list has not loaded yet', async () => {
  await act(async () => root.render(<Harness selectedChat={direct} />))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300)
  })
  expect(sent).toEqual([{ type: 'watch_sidebar', version: 1, chatIds: [direct.id] }])
  expect(watch.sidebarPresence).toEqual({ [bob.id]: 'unknown' })
  await act(async () => {
    watch.onEvent({
      type: 'sidebar_presence',
      version: 1,
      observedAt: new Date().toISOString(),
      validForMs: 15000,
      statuses: [{ userId: bob.id, state: 'online' }],
    })
  })
  expect(watch.sidebarPresence[bob.id]).toBe('online')
})
