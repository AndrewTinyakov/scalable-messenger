import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Chat } from '../entities/chat/model'
import type { api } from '../shared/api/http'
import { useChatDirectory } from './useChatDirectory'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const older: Chat = {
  id: 'chat',
  kind: 'DIRECT',
  name: null,
  members: [],
  memberCount: 2,
  lastSequence: '2',
  unreadCount: 2,
  unreadCountCapped: false,
  activityAt: '2026-01-01T00:00:00Z',
  lastMessage: {
    id: 'old',
    sequence: '2',
    senderId: 'peer',
    senderUsername: 'peer',
    createdAt: '2026-01-01T00:00:00Z',
    bodyPreview: 'old',
    deleted: false,
  },
}
const newer: Chat = {
  ...older,
  lastSequence: '3',
  unreadCount: 0,
  activityAt: '2026-02-01T00:00:00Z',
  lastMessage: { ...older.lastMessage!, id: 'new', sequence: '3', bodyPreview: 'new' },
}
let root: Root
let dom: JSDOM
let directory: ReturnType<typeof useChatDirectory>
const chats = vi.fn()
const chat = vi.fn()
const options = {
  sessionApi: { chats, chat } as unknown as ReturnType<typeof api.forSession>,
  selectedId: null,
  selectedIdRef: { current: null },
  recordLatest: vi.fn(),
  onRefreshed: vi.fn(),
  setError: vi.fn(),
}
function Harness() {
  directory = useChatDirectory(options)
  return null
}
beforeEach(async () => {
  dom = new JSDOM('<div id="root"></div>')
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  chats.mockReset().mockResolvedValue({ chats: [older], nextCursor: null })
  chat.mockReset()
  root = createRoot(document.getElementById('root')!)
  await act(async () => {
    root.render(<Harness />)
  })
})
afterEach(async () => {
  await act(async () => root.unmount())
  dom.window.close()
  vi.unstubAllGlobals()
})
it('discards a superseded summary completed after the newer summary', async () => {
  const first = deferred<Chat>()
  const second = deferred<Chat>()
  chat.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  let pending!: Promise<void>
  await act(async () => {
    pending = directory.refreshChatSummary('chat')
    const latest = directory.refreshChatSummary('chat')
    second.resolve(newer)
    await latest
  })
  await act(async () => {
    first.resolve(older)
    await pending
  })
  expect(directory.chats[0]).toEqual(newer)
})
it.each(['directory', 'summary'] as const)(
  'keeps the newer response when %s starts first and completes last',
  async (first) => {
    const page = deferred<{ chats: Chat[]; nextCursor: null }>()
    const summary = deferred<Chat>()
    chats.mockReturnValueOnce(page.promise)
    chat.mockReturnValueOnce(summary.promise)
    let firstRequest!: Promise<unknown>
    await act(async () => {
      firstRequest =
        first === 'directory' ? directory.refreshChats() : directory.refreshChatSummary('chat')
      const latest =
        first === 'directory' ? directory.refreshChatSummary('chat') : directory.refreshChats()
      if (first === 'directory') summary.resolve(newer)
      else page.resolve({ chats: [newer], nextCursor: null })
      await latest
    })
    await act(async () => {
      if (first === 'directory') page.resolve({ chats: [older], nextCursor: null })
      else summary.resolve(older)
      await firstRequest
    })
    expect(directory.chats[0]).toEqual(newer)
  },
)
it('does not restore an unread badge after a read on another device at the same sequence', async () => {
  const first = deferred<Chat>()
  chat.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ ...older, unreadCount: 0 })
  let pending!: Promise<void>
  await act(async () => {
    pending = directory.refreshChatSummary('chat')
    await directory.refreshChatSummary('chat')
  })
  await act(async () => {
    first.resolve(older)
    await pending
  })
  expect(directory.chats[0].unreadCount).toBe(0)
})
