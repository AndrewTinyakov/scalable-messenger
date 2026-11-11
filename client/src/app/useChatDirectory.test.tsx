import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Chat } from '../entities/chat/model'
import type { api } from '../shared/api/http'
import { useChatDirectory } from './useChatDirectory'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
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
it.each([
  ['directory', 'before'],
  ['directory', 'after'],
  ['summary', 'before'],
  ['summary', 'after'],
] as const)(
  'applies the successful %s when the later request fails %s it completes',
  async (first, failureTiming) => {
    const other = { ...older, id: 'other', activityAt: '2026-01-15T00:00:00Z' }
    await act(async () => directory.rememberChat(other))
    const page = deferred<{ chats: Chat[]; nextCursor: null }>()
    const summary = deferred<Chat>()
    chats.mockReturnValueOnce(page.promise)
    chat.mockReturnValueOnce(summary.promise)
    const failure = new Error('Connection lost')
    let successful!: Promise<unknown>
    let failed!: Promise<unknown>
    await act(async () => {
      successful =
        first === 'directory' ? directory.refreshChats() : directory.refreshChatSummary('chat')
      failed =
        first === 'directory'
          ? directory.refreshChatSummary('chat').catch((cause: unknown) => cause)
          : directory.refreshChats()
    })
    const fail = async () => {
      if (first === 'directory') summary.reject(failure)
      else page.reject(failure)
      await failed
    }
    if (failureTiming === 'before') await act(fail)
    await act(async () => {
      if (first === 'directory') page.resolve({ chats: [newer, other], nextCursor: null })
      else summary.resolve(newer)
      await successful
    })
    if (failureTiming === 'after') await act(fail)
    expect(directory.chats).toEqual([newer, other])
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

it('includes a chat activated ahead of the cursor exactly once when pagination completes', async () => {
  const rows: Chat[] = Array.from({ length: 130 }, (_, index) => ({
    ...older,
    id: `chat-${index}`,
    activityAt: new Date(Date.UTC(2026, 0, 1, 0, 130 - index)).toISOString(),
  }))
  chats.mockImplementation(async (cursor?: string) => {
    const start = cursor ? rows.findIndex((row) => row.id === cursor) + 1 : 0
    const page = rows.slice(start, start + 50)
    return {
      chats: page,
      nextCursor: start + 50 < rows.length ? page.at(-1)!.id : null,
    }
  })
  await act(async () => directory.refreshChats(true))
  expect(directory.chats).toHaveLength(100)
  expect(directory.hasMoreChats).toBe(true)
  const moved = { ...rows.splice(115, 1)[0], ...newer, id: 'chat-115' }
  rows.unshift(moved)
  chats.mockClear()
  await act(async () => directory.loadMoreChats())
  expect(directory.hasMoreChats).toBe(false)
  expect(directory.chats).toHaveLength(130)
  expect(new Set(directory.chats.map((row) => row.id)).size).toBe(130)
  expect(directory.chats[0]).toEqual(moved)
  expect(chats.mock.calls.map(([cursor]) => cursor)).toEqual(['chat-99', undefined])
})

it.each(['remove', 'summary', 'refresh'] as const)(
  'preserves a later %s while merging the first page during pagination',
  async (change) => {
    const initial = Array.from({ length: 100 }, (_, index) => ({
      ...older,
      id: index === 0 ? older.id : `loaded-${index}`,
    }))
    chats.mockResolvedValueOnce({ chats: initial, nextCursor: 'more' })
    await act(async () => directory.refreshChats(true))
    const firstPage = deferred<{ chats: Chat[]; nextCursor: string | null }>()
    const incoming = { ...older, id: 'incoming' }
    chats
      .mockResolvedValueOnce({ chats: [incoming], nextCursor: null })
      .mockReturnValueOnce(firstPage.promise)
    let pending!: Promise<void>
    await act(async () => {
      pending = directory.loadMoreChats()
      await Promise.resolve()
    })
    await act(async () => {
      if (change === 'remove') {
        directory.removeChat(older.id)
        directory.removeChat(incoming.id)
      } else if (change === 'summary') {
        chat.mockResolvedValueOnce(newer)
        await directory.refreshChatSummary(older.id)
      } else {
        chats.mockResolvedValueOnce({ chats: [newer], nextCursor: null })
        await directory.refreshChats(true)
      }
    })
    await act(async () => {
      firstPage.resolve({ chats: [older, incoming], nextCursor: 'ignored' })
      await pending
    })
    if (change === 'remove') {
      expect(directory.chats.some((row) => [older.id, incoming.id].includes(row.id))).toBe(false)
    } else {
      expect(directory.chats.find((row) => row.id === older.id)).toEqual(newer)
    }
    if (change === 'refresh') expect(directory.chats).toEqual([newer])
    expect(directory.hasMoreChats).toBe(false)
  },
)

it('starts the first-page refresh while the next page is still pending', async () => {
  chats.mockResolvedValueOnce({
    chats: Array.from({ length: 100 }, (_, index) => ({
      ...older,
      id: index ? `loaded-${index}` : older.id,
    })),
    nextCursor: 'more',
  })
  await act(async () => directory.refreshChats(true))
  const page = deferred<{ chats: Chat[]; nextCursor: null }>()
  const firstPage = deferred<{ chats: Chat[]; nextCursor: null }>()
  chats.mockClear().mockReturnValueOnce(page.promise).mockReturnValueOnce(firstPage.promise)
  let loading!: Promise<void>
  await act(async () => {
    loading = directory.loadMoreChats()
  })
  const started = chats.mock.calls.map(([cursor]) => cursor)
  await act(async () => {
    firstPage.resolve({ chats: [newer], nextCursor: null })
    page.resolve({ chats: [{ ...older, id: 'next' }], nextCursor: null })
    await loading
  })
  expect(started).toEqual(['more', undefined])
  expect(directory.chats.find((chat) => chat.id === older.id)).toEqual(newer)
  expect(directory.chats.some((chat) => chat.id === 'next')).toBe(true)
})
