import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Chat } from '../entities/chat/model'
import { PresenceStore } from '../features/presence/presenceStore'
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
let sent: OutgoingSocketFrame[]
let presence: PresenceStore

function Harness({ selectedChat, loaded = [] }: { selectedChat?: Chat; loaded?: Chat[] }) {
  useSidebarWatch({
    connectionGeneration: 1,
    connected: true,
    userId: alice.id,
    selectedChat,
    presence,
    listChats: () => loaded,
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
  presence = new PresenceStore()
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

it('follows activity for the selected chat and presence for every loaded direct peer', async () => {
  const watched: OutgoingSocketFrame[] = []
  presence.connect((frame) => watched.push(frame))
  await act(async () => root.render(<Harness selectedChat={direct} loaded={[direct]} />))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1300)
  })
  expect(sent).toEqual([{ type: 'watch_sidebar', version: 1, chatIds: [direct.id] }])
  expect(watched.at(-1)).toEqual({ type: 'watch_presence', version: 1, add: [bob.id], remove: [] })
})
