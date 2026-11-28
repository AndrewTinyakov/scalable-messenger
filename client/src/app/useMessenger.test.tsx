import { JSDOM } from 'jsdom'
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Chat } from '../entities/chat/model'
import type { Message } from '../entities/message/model'
import type { Session } from '../entities/session/model'
import { ChatKind, FrameType } from '../shared/api/generated/socket-vocabulary'
import { ChatPanel } from '../widgets/chat-panel/ChatPanel'
import { App } from './App'
import { TestSocket } from './TestSocket.fixtures'
import { useMessenger } from './useMessenger'

const userId = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const chatId = '01ARZ3NDEKTSV4RRFFQ69G5FAW'
const session: Session = { user: { id: userId, username: 'alice' }, deviceId: 'device' }
const recipient = { id: '01ARZ3NDEKTSV4RRFFQ69G5FAX', username: 'bob' }
const direct = {
  id: '01ARZ3NDEKTSV4RRFFQ69G5FB0',
  kind: 'DIRECT',
  name: null,
  members: [session.user, recipient],
  memberCount: 2,
  lastSequence: '0',
}
const group = {
  id: chatId,
  kind: 'GROUP',
  name: 'Group',
  members: [],
  memberCount: 100,
  lastSequence: '0',
}
const onSessionRevoked = () => {}

let dom: JSDOM
let root: Root
let container: HTMLDivElement
let messenger: ReturnType<typeof useMessenger>
let sockets: TestSocket[]
let paths: string[]
let holdChatRequests: boolean
let chatRequests: ((value: Response) => void)[]
let sessionRequests: ((value: Response) => void)[]
let logoutRequests: ((value: Response) => void)[]
let failChatRequest: boolean
let failHistoryRequest: boolean
let existingDirect: boolean
let failDirectLookup: boolean
let historyMessages: Message[]
let groupMemberCount: number
let groupMembers: Session['user'][]
let renderPanel: boolean
let fakeUnread: number
let holdReadRequests: boolean
let readRequests: ((value: Response) => void)[]
let readCalls: string[]
let memberSeq: string
let clearedThrough: string
let lastSummary: Chat['lastMessage']
let hidden: boolean
let deletionCalls: { chatId: string; requestId: string; scope: string; target: string }[]
let failDeletion: boolean
let markedUnread: boolean
let userSeq = 0
let pinFailures = 0
let stateMemberSeq: string | undefined
let stateRequests: { primary: boolean; fail?: boolean; release?: () => void }[] = []
let holdState = false
let unreadMarkCalls: string[]

function snapshotFor(id: string) {
  return {
    snapshotSequence:
      historyMessages.filter((message) => message.chatId === id).at(-1)?.sequence ?? '0',
    mutationSeq: '0',
    visibilitySeq: memberSeq,
    clearedThroughSequence: clearedThrough,
    globalClearedThroughSequence: '0',
  }
}

function Harness() {
  const current = useMessenger(session, onSessionRevoked)
  useEffect(() => {
    messenger = current
  })
  const selected = current.chats.find((chat) => chat.id === current.selectedId)
  if (renderPanel)
    return (
      <ChatPanel
        chat={selected}
        currentUser={session.user}
        messages={selected ? (current.messages[selected.id] ?? []) : []}
        pending={current.pending}
        connection={current.connection}
        features={current.features}
        onSend={current.sendMessage}
        onRetry={current.retryMessage}
        onBack={current.closeChat}
        hasOlder={current.hasOlderMessages}
        hasNewer={current.hasNewerMessages}
        hasUnresolvedGap={current.hasUnresolvedGap}
        loadingOlder={current.loadingOlder}
        loadingNewer={current.loadingNewer}
        onLoadOlder={() => selected && void current.loadOlder(selected.id)}
        onLoadNewer={() => selected && void current.loadNewer(selected.id)}
        onJumpToLatest={() => selected && void current.showLatest(selected.id)}
        jumpRevision={current.jumpRevision}
        onViewPositionChange={(latest) =>
          selected && current.setAtLatestPosition(selected.id, latest)
        }
        readingLocation={current.location}
        locationRevision={current.locationRevision}
        onLocationChange={current.rememberLocation}
      />
    )
  return (
    <div>
      {current.chats.map((chat) => (
        <span key={chat.id}>{chat.name}</span>
      ))}
    </div>
  )
}

function chatCreated(socket: TestSocket, eventId: string) {
  socket.event({
    type: 'chat_created',
    version: 1,
    eventId,
    room: `user:${userId}`,
    epoch: 'epoch',
    streamId: '1-0',
    chatId,
    userSeq: String(++userSeq),
  })
}

async function renderMessenger() {
  await act(async () => {
    root.render(<Harness />)
  })
}

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('localStorage', dom.window.localStorage)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  sockets = []
  paths = []
  holdChatRequests = false
  chatRequests = []
  sessionRequests = []
  logoutRequests = []
  failChatRequest = false
  failHistoryRequest = false
  existingDirect = false
  failDirectLookup = false
  historyMessages = []
  groupMemberCount = group.memberCount
  groupMembers = [session.user]
  renderPanel = false
  fakeUnread = 0
  holdReadRequests = false
  readRequests = []
  readCalls = []
  memberSeq = '0'
  clearedThrough = '0'
  hidden = false
  lastSummary = null
  deletionCalls = []
  failDeletion = false
  markedUnread = false
  unreadMarkCalls = []
  vi.stubGlobal(
    'WebSocket',
    class extends TestSocket {
      constructor() {
        super()
        sockets.push(this)
      }
    },
  )
  vi.stubGlobal('fetch', async (input: string, options?: RequestInit) => {
    const url = new URL(input, 'http://localhost')
    const path = url.pathname
    paths.push(path)
    const requestedChat = path.split('/chats/')[1]?.split('/')[0] ?? chatId
    const metadata = snapshotFor(requestedChat)
    if (path.endsWith('/deletions')) {
      const body = JSON.parse(String(options?.body))
      deletionCalls.push({ chatId: requestedChat, ...body })
      if (failDeletion) return Response.json({ message: 'Unavailable' }, { status: 403 })
      return Response.json({
        operationId: body.requestId,
        scope: body.scope,
        target: body.target,
        clearedThroughSequence: '0',
        seq: '0',
        visibilitySeq: '1',
        state: 'COMPLETED',
        deletedRows: '0',
      })
    }
    if (path.endsWith('/unread-mark')) {
      unreadMarkCalls.push(options?.method ?? 'GET')
      markedUnread = options?.method === 'PUT'
      return Response.json({
        chatId: requestedChat,
        pinnedRank: null,
        mutedUntil: null,
        mutedForever: false,
        markedUnread,
      })
    }
    if (path.endsWith('/pins') && pinFailures > 0) {
      pinFailures -= 1
      return Response.json({ message: 'Unavailable' }, { status: 503 })
    }
    if (path.endsWith('/pins'))
      return Response.json({
        pins: [],
        totalCount: 0,
        pinnedMessageIds: [],
        nextBeforeSequence: null,
      })
    if (path.endsWith('/visibility')) return Response.json({ ...metadata, hidden })
    if (path.endsWith('/state')) {
      const request: (typeof stateRequests)[number] = { primary: !url.searchParams.has('minSeq') }
      stateRequests.push(request)
      if (holdState) await new Promise<void>((resolve) => (request.release = resolve))
      if (request.fail) return Response.json({ message: 'Unavailable' }, { status: 503 })
    }
    if (path.endsWith('/state'))
      return Response.json({
        lastSeq: metadata.snapshotSequence,
        pinsSeq: '0',
        mutationFloor: '0',
        mutationSeq: metadata.mutationSeq,
        memberSeq: stateMemberSeq ?? metadata.visibilitySeq,
        visibilitySeq: metadata.visibilitySeq,
        memberPinsSeq: '0',
        clearedThroughSequence: metadata.clearedThroughSequence,
        globalClearedThroughSequence: metadata.globalClearedThroughSequence,
        hidden,
        ownReadThrough: readCalls.at(-1) ?? '0',
        otherReadThrough: '0',
        userSeq: '0',
      })
    if (path.endsWith('/changes'))
      return Response.json({
        ...metadata,
        changes: [],
        lastSeq: '0',
        nextSeq: '0',
        resetRequired: false,
      })
    if (path.endsWith('/resolve')) {
      const { messageIds } = JSON.parse(String(options?.body)) as { messageIds: string[] }
      return Response.json({
        ...metadata,
        messages: historyMessages.filter(
          (message) =>
            messageIds.includes(message.id) && BigInt(message.sequence) > BigInt(clearedThrough),
        ),
      })
    }
    if (path.endsWith('/reads')) {
      if (options?.method === 'POST') {
        const { throughSequence } = JSON.parse(String(options.body)) as { throughSequence: string }
        readCalls.push(throughSequence)
        if (holdReadRequests) return new Promise<Response>((resolve) => readRequests.push(resolve))
        return Response.json({
          throughSequence,
          readAt: new Date().toISOString(),
          serverTime: new Date().toISOString(),
        })
      }
      return Response.json({
        throughSequence: readCalls.at(-1) ?? '0',
        maxOtherReadSequence: '0',
        serverTime: new Date().toISOString(),
      })
    }
    if (path.endsWith('/session'))
      return new Promise<Response>((resolve) => {
        sessionRequests.push(resolve)
      })
    if (path.endsWith('/logout'))
      return new Promise<Response>((resolve) => {
        logoutRequests.push(resolve)
      })
    if (path.endsWith('/ws-ticket'))
      return Response.json({
        token: 'header.claims.signature',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      })
    if (path.endsWith(`/chats/direct/${recipient.id}`))
      return failDirectLookup
        ? Response.json({ message: 'User not found' }, { status: 404 })
        : Response.json({ recipient, chat: existingDirect ? direct : null })
    if (path.endsWith('/messages')) {
      if (failHistoryRequest) {
        failHistoryRequest = false
        return Response.json({ message: 'Unavailable' }, { status: 403 })
      }
      const after = new URL(input, 'http://localhost').searchParams.get('afterSeq')
      const before = new URL(input, 'http://localhost').searchParams.get('beforeSeq')
      const eligible = historyMessages.filter(
        (message) =>
          path.endsWith(`/chats/${message.chatId}/messages`) &&
          (after === null || BigInt(message.sequence) > BigInt(after)) &&
          (before === null || BigInt(message.sequence) < BigInt(before)) &&
          BigInt(message.sequence) > BigInt(clearedThrough),
      )
      const messages = after === null ? eligible.slice(-50) : eligible.slice(0, 50)
      const hasMore = eligible.length > messages.length
      return Response.json({
        messages,
        ...metadata,
        coverageAfterSequence:
          after ??
          (hasMore && messages.length ? (BigInt(messages[0].sequence) - 1n).toString() : '0'),
        coverageThroughSequence:
          after !== null && hasMore
            ? messages.at(-1)!.sequence
            : before === null
              ? metadata.snapshotSequence
              : (BigInt(before) - 1n).toString(),
        nextSequence:
          after === null
            ? (messages[0]?.sequence ?? '0')
            : hasMore
              ? messages.at(-1)!.sequence
              : metadata.snapshotSequence,
        hasMore,
      })
    }
    if (path.endsWith(`/chats/${chatId}`))
      return Response.json({
        ...group,
        lastMessage: lastSummary,
        markedUnread,
        unreadCount: fakeUnread,
        memberCount: groupMemberCount,
        members: groupMembers,
      })
    if (path.endsWith('/chats')) {
      if (failChatRequest) {
        failChatRequest = false
        return Response.json({ message: 'Unavailable' }, { status: 403 })
      }
      if (holdChatRequests)
        return new Promise<Response>((resolve) => {
          chatRequests.push(resolve)
        })
      return Response.json({
        chats: hidden
          ? []
          : [
              {
                ...group,
                markedUnread,
                unreadCount: fakeUnread,
                memberCount: groupMemberCount,
                lastSequence: snapshotFor(chatId).snapshotSequence,
              },
            ],
        nextCursor: null,
      })
    }
    throw new Error(`Unexpected request ${path}`)
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  dom.window.close()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('messenger request coordination', () => {
  it('jumps into a cached latest window that skips a hidden sequence', async () => {
    historyMessages = Array.from({ length: 100 }, (_, index) => ({
      id: String(index + 1).padStart(26, '0'),
      chatId,
      senderId: recipient.id,
      sequence: String(index + 1),
      body: `Message ${index + 1}`,
      createdAt: '2026-11-04T10:00:00Z',
    })).filter((message) => message.sequence !== '90')
    window.history.replaceState(null, '', `/groups/${chatId}`)
    await renderMessenger()
    await act(async () => sockets[0].open())
    const fetch = globalThis.fetch
    const around: string[] = []
    vi.stubGlobal('fetch', (input: string, options?: RequestInit) => {
      if (!input.includes('/messages/around')) return fetch(input, options)
      const anchor = new URL(input, 'http://localhost').searchParams.get('messageId')!
      around.push(anchor)
      const index = historyMessages.findIndex((message) => message.id === anchor)
      const messages = index < 50 ? historyMessages.slice(0, 50) : historyMessages.slice(-50)
      return Promise.resolve(
        Response.json({
          ...snapshotFor(chatId),
          messages,
          anchorMessageId: anchor,
          hasOlder: index >= 50,
          hasNewer: index < 50,
          coverageAfterSequence: (BigInt(messages[0].sequence) - 1n).toString(),
          coverageThroughSequence: messages.at(-1)!.sequence,
        }),
      )
    })
    await act(async () => messenger.features.jumpToMessage(historyMessages[0].id, false))
    expect(messenger.detached).toBe(true)
    const target = historyMessages.find((message) => message.sequence === '95')!
    await act(async () => messenger.features.jumpToMessage(target.id, false))
    expect(messenger.messages[chatId].some((message) => message.id === target.id)).toBe(true)
    expect(messenger.features.reveal?.messageId).toBe(target.id)
    expect(messenger.error).toBeNull()
  })

  it.each(['quote navigation', 'location restore'] as const)(
    'keeps the latest window when an accepted send supersedes delayed %s',
    async (navigation) => {
      historyMessages = Array.from({ length: 100 }, (_, index) => ({
        id: String(index + 1).padStart(26, '0'),
        chatId,
        senderId: recipient.id,
        sequence: String(index + 1),
        body: `Message ${index + 1}`,
        createdAt: '2026-11-04T10:00:00Z',
      }))
      window.history.replaceState(null, '', `/groups/${chatId}`)
      await renderMessenger()
      await act(async () => sockets[0].open())
      const latest = messenger.messages[chatId]
      expect(latest[0].sequence).toBe('51')
      const fetch = globalThis.fetch
      let release!: (response: Response) => void
      const around = new Promise<Response>((resolve) => {
        release = resolve
      })
      const requests: string[] = []
      vi.stubGlobal('fetch', (input: string, options?: RequestInit) => {
        requests.push(input)
        return input.includes('/messages/around') ? around : fetch(input, options)
      })
      let jump: Promise<void> | undefined
      if (navigation === 'quote navigation') {
        await act(async () => {
          jump = messenger.features.jumpToMessage(historyMessages[0].id, false)
        })
      } else {
        await act(async () => messenger.closeChat())
        messenger.rememberLocation(chatId, {
          messageId: historyMessages[0].id,
          sequence: '1',
          offsetPx: -17,
          atLatest: false,
        })
        await act(async () => messenger.selectChat(chatId))
      }
      expect(requests.filter((path) => path.includes('/messages/around'))).toHaveLength(1)
      expect(messenger.detached).toBe(false)
      expect(messenger.hasNewerMessages).toBe(false)
      const revision = messenger.locationRevision
      const windowBeforeSend = messenger.messages[chatId]
      requests.length = 0
      await act(async () => {
        expect(messenger.sendMessage(chatId, 'Stay at latest')).toBe(true)
      })
      expect(requests).toEqual([])
      await act(async () => {
        release(
          Response.json({
            ...snapshotFor(chatId),
            messages: historyMessages.slice(0, 50),
            anchorMessageId: historyMessages[0].id,
            hasOlder: false,
            hasNewer: true,
            coverageAfterSequence: '0',
            coverageThroughSequence: '50',
          }),
        )
        await jump
      })
      expect(messenger.messages[chatId]).toEqual(windowBeforeSend)
      expect(messenger.detached).toBe(false)
      expect(messenger.hasNewerMessages).toBe(false)
      expect(messenger.locationRevision).toBe(revision)
      expect(messenger.features.reveal).toBeNull()
      expect(messenger.pending).toEqual([
        expect.objectContaining({ chatId, body: 'Stay at latest', status: 'sending' }),
      ])
      expect(messenger.error).toBeNull()
      expect(readCalls).toEqual([])
    },
  )

  it('clears the selected badge immediately while a read request waits and resists a stale summary', async () => {
    vi.useFakeTimers()
    fakeUnread = 4
    window.history.replaceState(null, '', `/groups/${chatId}`)
    await renderMessenger()
    await act(async () => sockets[0].open())
    expect(messenger.chats.find((chat) => chat.id === chatId)?.unreadCount).toBe(4)
    holdReadRequests = true
    await act(async () => messenger.features.readThrough('1'))
    expect(readRequests).toHaveLength(1)
    expect(messenger.chats.find((chat) => chat.id === chatId)?.unreadCount).toBe(0)
    await act(async () => {
      sockets[0].event({
        type: 'reads_changed',
        version: 1,
        eventId: recipient.id,
        room: `user:${userId}`,
        epoch: 'epoch',
        streamId: '1-0',
        chatId,
      })
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(messenger.chats.find((chat) => chat.id === chatId)?.unreadCount).toBe(0)
    fakeUnread = 0
    holdReadRequests = false
    await act(async () =>
      readRequests[0](
        Response.json({
          throughSequence: '1',
          readAt: new Date().toISOString(),
          serverTime: new Date().toISOString(),
        }),
      ),
    )
    expect(messenger.chats.find((chat) => chat.id === chatId)?.unreadCount).toBe(0)
  })

  it('clears an unopened group badge on another device read hint through the account room', async () => {
    vi.useFakeTimers()
    fakeUnread = 9
    await renderMessenger()
    await act(async () => {
      sockets[0].open()
      messenger.closeChat()
    })
    fakeUnread = 0
    paths = []
    stateMemberSeq = '1'
    await act(async () => {
      sockets[0].event({
        type: 'reads_changed',
        version: 1,
        eventId: recipient.id,
        room: `user:${userId}`,
        epoch: 'epoch',
        streamId: '1-0',
        chatId,
        memberSeq: '1',
      })
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(messenger.chats.find((chat) => chat.id === chatId)?.unreadCount).toBe(0)
    expect(paths.some((path) => path.endsWith('/messages'))).toBe(false)
  })

  it("leaves the chat-list row alone when another member's read reaches the group room", async () => {
    vi.useFakeTimers()
    await renderMessenger()
    await act(async () => {
      sockets[0].open()
      messenger.closeChat()
    })
    paths = []
    await act(async () => {
      sockets[0].event({
        type: 'reads_changed',
        version: 1,
        eventId: recipient.id,
        room: `group:${chatId}`,
        epoch: 'epoch',
        streamId: '1-0',
        chatId,
      })
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(paths.filter((path) => path.endsWith(`/chats/${chatId}`))).toHaveLength(0)
  })

  it('keeps an unread mark made while the chat stays selected and clears it on the next opening', async () => {
    vi.useFakeTimers()
    await renderMessenger()
    await act(async () => {
      sockets[0].open()
      messenger.selectChat(chatId)
      await vi.advanceTimersByTimeAsync(100)
    })
    const chat = () => messenger.chats.find((item) => item.id === chatId)!
    await act(async () => {
      await messenger.markChatUnread(chat(), true)
    })
    await act(async () => {
      sockets[0].event({
        type: 'chat_preferences_changed',
        version: 1,
        eventId: recipient.id,
        room: `user:${userId}`,
        epoch: 'epoch',
        streamId: '1-0',
        chatId,
      })
      await vi.advanceTimersByTimeAsync(2500)
      await messenger.refreshChats(true, true)
    })
    expect(chat().markedUnread).toBe(true)
    expect(unreadMarkCalls).toEqual(['PUT'])
    await act(async () => messenger.closeChat())
    await act(async () => {
      messenger.selectChat(chatId)
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(unreadMarkCalls).toEqual(['PUT', 'DELETE'])
    expect(chat().markedUnread).toBe(false)
  })

  it.each(['RATE_LIMITED', 'ROOM_LIMIT', 'DEPENDENCY_UNAVAILABLE', 'PUBLISH_FAILED'])(
    'silently retries %s sends with their original request ID',
    async (code) => {
      vi.useFakeTimers()
      await renderMessenger()
      await act(async () => {
        sockets[0].open()
        messenger.sendMessage(chatId, 'Keep waiting')
      })
      const sends = () =>
        sockets[0].sent.map((raw) => JSON.parse(raw)).filter((frame) => frame.type === 'send')
      const requestId = sends()[0].requestId
      await act(async () => sockets[0].event({ type: 'error', version: 1, requestId, code }))
      expect(messenger.pending[0].status).toBe('sending')
      expect(messenger.error).toBeNull()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500)
      })
      expect(sends().map((send) => send.requestId)).toEqual([requestId, requestId])
      expect(messenger.error).toBeNull()
    },
  )

  it('watches loaded direct peers once, applies transitions and restores the watch after reconnect', async () => {
    vi.useFakeTimers()
    window.history.replaceState(null, '', `/groups/${chatId}`)
    await renderMessenger()
    await act(async () => sockets[0].open())
    const presenceFrames = (socket: (typeof sockets)[number]) =>
      socket.sent.map((raw) => JSON.parse(raw)).filter((frame) => frame.type === 'watch_presence')
    expect(presenceFrames(sockets[0])[0]).toMatchObject({ reset: true })
    await act(async () => {
      messenger.updateChat({ ...direct, kind: ChatKind.DIRECT })
      messenger.watchSidebarPeers([direct.id, chatId])
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1750)
    })
    expect(presenceFrames(sockets[0]).at(-1)).toEqual({
      type: 'watch_presence',
      version: 1,
      add: [recipient.id],
      remove: [],
    })
    expect(
      sockets[0].sent
        .map((raw) => JSON.parse(raw))
        .filter((frame) => frame.type === 'watch_sidebar'),
    ).toEqual([{ type: 'watch_sidebar', version: 1, chatIds: [chatId, direct.id].sort() }])
    await act(async () =>
      sockets[0].event({
        type: 'presence',
        version: 1,
        statuses: [{ userId: recipient.id, online: true }],
      }),
    )
    expect(messenger.presence.getSnapshot().statuses.get(recipient.id)).toEqual({
      userId: recipient.id,
      online: true,
    })
    await act(async () => {
      sockets[0].close()
      await vi.advanceTimersByTimeAsync(1000)
      sockets[1].open()
    })
    expect(presenceFrames(sockets[1])[0]).toEqual({
      type: 'watch_presence',
      version: 1,
      reset: true,
      add: [recipient.id],
    })
  })

  it('coalesces received live hints into a fresh summary with the group sender username', async () => {
    vi.useFakeTimers()
    await renderMessenger()
    await act(async () => {
      sockets[0].open()
      messenger.closeChat()
    })
    lastSummary = {
      id: recipient.id,
      sequence: '7',
      senderId: recipient.id,
      senderUsername: 'katya',
      createdAt: '2026-11-04T10:00:00Z',
      bodyPreview: 'Хорошо',
      deleted: false,
    }
    paths = []
    await act(async () => {
      for (let index = 1; index <= 3; index++)
        sockets[0].event({
          type: 'sidebar_activity',
          version: 1,
          sequence: String(index),
          chatId,
        })
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(messenger.chats.find((chat) => chat.id === chatId)?.lastMessage).toEqual(lastSummary)
    expect(paths.filter((path) => path.endsWith(`/chats/${chatId}`))).toHaveLength(1)
    expect(messenger.selectedId).toBeNull()
  })

  it('shows group activity that carries its preview without fetching the row', async () => {
    vi.useFakeTimers()
    await renderMessenger()
    await act(async () => {
      sockets[0].open()
      messenger.closeChat()
    })
    const row = messenger.chats.find((chat) => chat.id === chatId)!
    const next = String(BigInt(row.lastSequence) + 1n)
    paths = []
    const activity = {
      type: 'sidebar_activity',
      version: 1,
      chatId,
      sequence: next,
      messageId: '01BX5ZZKBKACTAV9WEVGEMMVRZ',
      senderId: recipient.id,
      senderUsername: 'katya',
      createdAt: '2026-11-19T10:00:00Z',
      preview: 'Хорошо',
    }
    await act(async () => {
      sockets[0].event(activity)
      sockets[0].event(activity)
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(messenger.chats.find((chat) => chat.id === chatId)).toMatchObject({
      lastSequence: next,
      lastMessage: { id: activity.messageId, senderUsername: 'katya', bodyPreview: 'Хорошо' },
    })
    expect(paths.filter((path) => path.endsWith(`/chats/${chatId}`))).toHaveLength(0)
  })

  it('deletes a never-opened chat without changing selection or loading its history', async () => {
    await renderMessenger()
    const selected = messenger.selectedId
    paths = []
    await act(async () => {
      await messenger.deleteChatById(direct.id, 'SELF')
    })
    expect(deletionCalls).toEqual([
      { chatId: direct.id, requestId: expect.any(String), scope: 'SELF', target: 'CHAT' },
    ])
    expect(messenger.selectedId).toBe(selected)
    expect(paths.some((path) => path.includes(`/chats/${direct.id}/messages`))).toBe(false)
  })

  it('retains an arbitrary-chat deletion request ID after failure and uses a fresh one after success', async () => {
    await renderMessenger()
    failDeletion = true
    await act(async () => {
      await expect(messenger.clearChatHistory(direct.id, 'EVERYONE')).rejects.toThrow('Unavailable')
    })
    failDeletion = false
    await act(async () => {
      await messenger.clearChatHistory(direct.id, 'EVERYONE')
    })
    expect(deletionCalls[0]).toEqual(deletionCalls[1])
    expect(deletionCalls[1]).toMatchObject({
      chatId: direct.id,
      scope: 'EVERYONE',
      target: 'HISTORY',
    })
    await act(async () => {
      await messenger.clearChatHistory(direct.id, 'EVERYONE')
    })
    expect(deletionCalls[2].requestId).not.toBe(deletionCalls[1].requestId)
    expect(paths.some((path) => path.includes(`/chats/${direct.id}/messages`))).toBe(false)
  })

  it('pauses directory and pending-send polling for the whole offline interval', async () => {
    vi.useFakeTimers()
    let online = true
    vi.spyOn(dom.window.navigator, 'onLine', 'get').mockImplementation(() => online)
    await renderMessenger()
    await act(async () => {
      sockets[0].open()
      messenger.sendMessage(chatId, 'Waiting for a result')
    })
    paths = []
    await act(async () => {
      online = false
      window.dispatchEvent(new dom.window.Event('offline'))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90000)
    })
    expect(paths).toEqual([])
    expect(messenger.pending).toHaveLength(1)
    expect(messenger.error).toBeNull()
    await act(async () => {
      online = true
      window.dispatchEvent(new dom.window.Event('online'))
      await vi.advanceTimersByTimeAsync(1000)
      sockets[1].open()
    })
    expect(paths.some((path) => path.includes('/sends/status'))).toBe(true)
  })

  it('keeps cached chats without a toast when an in-flight refresh fails offline', async () => {
    let online = true
    vi.spyOn(dom.window.navigator, 'onLine', 'get').mockImplementation(() => online)
    await renderMessenger()
    const chats = messenger.chats
    holdChatRequests = true
    let refresh!: Promise<unknown>
    await act(async () => {
      refresh = messenger.refreshChats()
    })
    await act(async () => {
      online = false
      window.dispatchEvent(new dom.window.Event('offline'))
      chatRequests[0](Response.json({ message: 'Failed to fetch' }, { status: 403 }))
      await refresh
    })
    expect(messenger.chats).toEqual(chats)
    expect(messenger.error).toBeNull()
  })

  it('hides another device history and sidebar, then resurfaces the same chat with its cutoff', async () => {
    historyMessages = ['1', '2'].map((sequence) => ({
      id: sequence.padStart(26, '0'),
      chatId,
      senderId: recipient.id,
      sequence,
      body: `Original ${sequence}`,
      createdAt: '2026-11-04T10:00:00Z',
    }))
    window.history.replaceState(null, '', `/groups/${chatId}`)
    await renderMessenger()
    await act(async () => sockets[0].open())
    expect(messenger.messages[chatId]).toHaveLength(2)
    clearedThrough = '2'
    memberSeq = '1'
    hidden = true
    await act(async () =>
      sockets[0].event({
        type: 'history_changed',
        version: 1,
        eventId: '01ARZ3NDEKTSV4RRFFQ69G5FAZ',
        room: `user:${userId}`,
        epoch: 'epoch',
        streamId: '3-0',
        chatId,
        sequence: '2',
        memberSeq: '1',
      }),
    )
    expect(messenger.selectedId).toBeNull()
    expect(messenger.chats.some((chat) => chat.id === chatId)).toBe(false)
    expect(messenger.messages[chatId]).toEqual([])
    historyMessages.push({
      id: '00000000000000000000000003',
      chatId,
      senderId: recipient.id,
      sequence: '3',
      body: 'New message',
      createdAt: '2026-11-04T10:01:00Z',
    })
    hidden = false
    await act(async () =>
      sockets[0].event({
        type: 'message_saved',
        version: 1,
        eventId: '01ARZ3NDEKTSV4RRFFQ69G5FB0',
        room: `group:${chatId}`,
        epoch: 'epoch',
        streamId: '4-0',
        chatId,
        requestId: '01ARZ3NDEKTSV4RRFFQ69G5FB1',
        messageId: '00000000000000000000000003',
        sequence: '3',
        senderId: recipient.id,
        body: 'New message',
        createdAt: '2026-11-04T10:01:00Z',
      }),
    )
    expect(messenger.chats.some((chat) => chat.id === chatId)).toBe(true)
    await act(async () => messenger.selectChat(chatId))
    expect(messenger.messages[chatId].map((message) => message.sequence)).toEqual(['3'])
  })
  it(
    'reads visible rows after a background burst through the actual socket, messenger and panel callers',
    { timeout: 20_000 },
    async () => {
      vi.useFakeTimers()
      renderPanel = true
      let focused = false
      vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
      const positions = new WeakMap<HTMLElement, number>()
      Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollHeight', {
        configurable: true,
        get() {
          return this.matches('.chat-body')
            ? this.querySelectorAll('[data-message-id]').length * 40
            : 0
        },
      })
      Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', {
        configurable: true,
        get() {
          return this.matches('.chat-body') ? 400 : 0
        },
      })
      Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollTop', {
        configurable: true,
        get() {
          return positions.get(this) ?? 0
        },
        set(value) {
          positions.set(
            this,
            Math.min(Math.max(0, value), Math.max(0, this.scrollHeight - this.clientHeight)),
          )
        },
      })
      vi.spyOn(dom.window.HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
        function (this: HTMLElement) {
          const scroller = this.closest<HTMLElement>('.chat-body')
          const index = scroller
            ? [...scroller.querySelectorAll('[data-message-id]')].indexOf(this)
            : -1
          const top = this.matches('.chat-body') ? 0 : index * 40 - (scroller?.scrollTop ?? 0)
          const height = this.matches('.chat-body') ? 400 : 40
          return {
            top,
            bottom: top + height,
            height,
            left: 0,
            right: 500,
            width: 500,
            x: 0,
            y: top,
            toJSON: () => ({}),
          } as DOMRect
        },
      )
      window.history.replaceState(null, '', `/groups/${chatId}`)
      await renderMessenger()
      await act(async () => sockets[0].open())
      for (let batch = 0; batch < 10; batch += 1)
        await act(async () => {
          for (let index = 1; index <= 40; index += 1) {
            const sequence = String(batch * 40 + index)
            const row = {
              id: sequence.padStart(26, '0'),
              chatId,
              senderId: recipient.id,
              sequence,
              body: `Message ${sequence}`,
              createdAt: '2026-11-04T10:00:00Z',
            }
            historyMessages.push(row)
            const { id, ...fields } = row
            sockets[0].event({
              type: 'message_saved',
              version: 1,
              eventId: String(Number(sequence) + 1000).padStart(26, '0'),
              room: `group:${chatId}`,
              epoch: 'epoch',
              streamId: `${sequence}-0`,
              requestId: String(Number(sequence) + 2000).padStart(26, '0'),
              messageId: id,
              ...fields,
            })
          }
          await vi.advanceTimersByTimeAsync(50)
        })
      await act(async () => vi.advanceTimersByTimeAsync(2000))
      expect(messenger.messages[chatId].at(-1)?.sequence).toBe('400')
      expect(readCalls).toEqual([])
      focused = true
      await act(async () => {
        window.dispatchEvent(new dom.window.Event('focus'))
        await vi.advanceTimersByTimeAsync(699)
      })
      expect(readCalls).toEqual([])
      await act(async () => vi.advanceTimersByTimeAsync(1001))
      expect(readCalls.at(-1)).toBe('400')
    },
  )
  it('refreshes an open group after a member is added on another device', async () => {
    groupMemberCount = 2
    groupMembers = [session.user, recipient]
    window.history.replaceState(null, '', `/groups/${chatId}`)
    await renderMessenger()
    await act(async () => {
      sockets[0].open()
    })
    const charlie = { id: '01ARZ3NDEKTSV4RRFFQ69G5FAY', username: 'charlie' }
    groupMemberCount = 3
    groupMembers = [session.user, recipient, charlie]
    await act(async () => {
      sockets[0].event({
        type: 'membership_changed',
        version: 1,
        eventId: '01ARZ3NDEKTSV4RRFFQ69G5FAZ',
        room: `group:${chatId}`,
        epoch: 'epoch',
        streamId: '3-0',
        chatId,
        seq: '5',
      })
    })
    expect(messenger.chats.find((chat) => chat.id === chatId)).toMatchObject({
      memberCount: 3,
      members: [session.user, recipient, charlie],
    })
    expect(messenger.selectedId).toBe(chatId)
    expect(window.location.pathname).toBe(`/groups/${chatId}`)
  })
  it.each([2, 3])(
    'refreshes the remaining members when the resulting count is %s without closing the group',
    async (count) => {
      const charlie = { id: '01ARZ3NDEKTSV4RRFFQ69G5FAY', username: 'charlie' }
      const dave = { id: '01ARZ3NDEKTSV4RRFFQ69G5FB1', username: 'dave' }
      groupMemberCount = 3
      groupMembers = [session.user, recipient, charlie]
      window.history.replaceState(null, '', `/groups/${chatId}`)
      await renderMessenger()
      await act(async () => {
        sockets[0].open()
      })
      expect(messenger.chats.find((chat) => chat.id === chatId)?.members).toContainEqual(recipient)

      holdChatRequests = true
      await act(async () => {
        sockets[0].event({
          type: 'member_removed',
          version: 1,
          eventId: '01ARZ3NDEKTSV4RRFFQ69G5FAZ',
          room: `group:${chatId}`,
          epoch: 'epoch',
          streamId: '2-0',
          chatId,
          memberId: recipient.id,
          seq: '5',
        })
      })

      groupMemberCount = count
      groupMembers = count === 2 ? [session.user, charlie] : [session.user, charlie, dave]
      await act(async () => {
        chatRequests[0](
          Response.json({ chats: [{ ...group, memberCount: count }], nextCursor: null }),
        )
      })

      expect(messenger.selectedId).toBe(chatId)
      expect(messenger.chats.find((chat) => chat.id === chatId)).toMatchObject({
        memberCount: count,
        members: groupMembers,
      })
      expect(window.location.pathname).toBe(`/groups/${chatId}`)
    },
  )
  it('preserves Forward history when restoring a trailing-slash conversation URL', async () => {
    existingDirect = true
    window.history.replaceState(null, '', `/users/${recipient.id}/`)
    window.history.pushState(null, '', `/groups/${chatId}`)
    await renderMessenger()
    expect(messenger.selectedId).toBe(chatId)

    await act(async () => {
      window.history.back()
      await vi.waitFor(() => expect(window.location.pathname).toMatch(/^\/users\//))
    })
    expect(messenger.selectedId).toBe(direct.id)
    expect(window.location.pathname).toBe(`/users/${recipient.id}`)

    await act(async () => {
      window.history.forward()
      await vi.waitFor(() => expect(window.location.pathname).toBe(`/groups/${chatId}`))
    })
    expect(messenger.selectedId).toBe(chatId)
  })
  it('restores the latest visible messages when returning through browser history', async () => {
    existingDirect = true
    historyMessages = ['1', '2', '3'].map((sequence) => ({
      id: sequence.padStart(26, '0'),
      chatId: direct.id,
      senderId: recipient.id,
      sequence,
      body: `Message ${sequence}`,
      createdAt: '2026-11-01T10:00:00Z',
    }))
    window.history.replaceState(null, '', `/users/${recipient.id}`)
    await renderMessenger()
    await act(async () => sockets[0].open())
    expect(messenger.messages[direct.id]?.map((message) => message.body)).toEqual([
      'Message 1',
      'Message 2',
      'Message 3',
    ])
    await act(async () => messenger.selectChat(chatId))
    expect(messenger.messages[direct.id]).toHaveLength(1)

    await act(async () => {
      window.history.replaceState(null, '', `/users/${recipient.id}`)
      window.dispatchEvent(new dom.window.PopStateEvent('popstate'))
    })

    expect(messenger.messages[direct.id]?.map((message) => message.body)).toEqual([
      'Message 1',
      'Message 2',
      'Message 3',
    ])
  })
  it('restores an unsent direct conversation from its recipient URL without fetching draft history', async () => {
    window.history.replaceState(null, '', `/users/${recipient.id}`)
    await renderMessenger()
    await act(async () => {
      sockets[0].open()
      window.dispatchEvent(new dom.window.Event('focus'))
    })
    expect(messenger.draftChat?.members).toEqual([session.user, recipient])
    expect(messenger.selectedId).toBe(`draft:${recipient.id}`)
    await act(async () => {
      expect(messenger.sendMessage(`draft:${recipient.id}`, 'First message')).toBe(true)
    })
    expect(paths.some((path) => path.includes('/chats/draft'))).toBe(false)
    expect(window.location.pathname).toBe(`/users/${recipient.id}`)
  })

  it('resolves an existing direct conversation outside the first directory page and handles navigation', async () => {
    existingDirect = true
    window.history.replaceState(null, '', `/users/${recipient.id}`)
    await renderMessenger()
    expect(messenger.selectedId).toBe(direct.id)
    expect(messenger.chats.some((chat) => chat.id === direct.id)).toBe(true)
    await act(async () => messenger.selectChat(chatId))
    expect(window.location.pathname).toBe(`/groups/${chatId}`)
    await act(async () => {
      window.history.replaceState(null, '', `/users/${recipient.id}`)
      window.dispatchEvent(new dom.window.PopStateEvent('popstate'))
    })
    expect(messenger.selectedId).toBe(direct.id)
    await act(async () => messenger.closeChat())
    expect(window.location.pathname).toBe('/')
    expect(messenger.selectedId).toBeNull()
  })

  it('reports an unknown recipient without silently opening another chat', async () => {
    failDirectLookup = true
    window.history.replaceState(null, '', `/users/${recipient.id}`)
    await renderMessenger()
    expect(messenger.selectedId).toBeNull()
    expect(messenger.error).toBe('User not found')
  })

  it('rejects malformed conversation links before requesting a typed ID', async () => {
    window.history.replaceState(null, '', '/users/invalid')
    await renderMessenger()
    expect(messenger.selectedId).toBeNull()
    expect(messenger.error).toBe('This conversation link is invalid.')
    expect(paths.some((path) => path.includes('invalid'))).toBe(false)
  })
  it('does not request persisted history when focusing an unsent direct chat', async () => {
    await renderMessenger()
    await act(async () => {
      sockets[0].open()
      await messenger.createDirect({ id: '01ARZ3NDEKTSV4RRFFQ69G5FAX', username: 'bob' })
    })
    paths = []

    await act(async () => {
      window.dispatchEvent(new dom.window.Event('focus'))
    })

    expect(messenger.selectedId).toBe('draft:01ARZ3NDEKTSV4RRFFQ69G5FAX')
    expect(paths.filter((path) => path.includes('/chats/draft'))).toEqual([])
  })
  it('subscribes to a newly available group on the existing socket without reloading', async () => {
    holdChatRequests = true
    await renderMessenger()
    await act(async () => {
      sockets[0].open()
      chatRequests[0](Response.json({ chats: [], nextCursor: null }))
    })
    expect(messenger.chats).toEqual([])

    await act(async () => {
      chatCreated(sockets[0], '01ARZ3NDEKTSV4RRFFQ69G5FAX')
    })
    await act(async () => {
      chatRequests[1](Response.json({ chats: [group], nextCursor: null }))
    })
    expect(messenger.selectedId).toBeNull()
    await act(async () => {
      messenger.selectChat(chatId)
    })

    expect(sockets).toHaveLength(1)
    expect(messenger.selectedId).toBe(chatId)
    expect(messenger.chats.map((chat) => chat.id)).toEqual([chatId])
    expect(sockets[0].sent.map((data) => JSON.parse(data))).toContainEqual({
      type: FrameType.SUBSCRIBE_MANY,
      version: 1,
      subscriptions: [{ chatId, kind: ChatKind.GROUP, lastAppliedSequence: '0' }],
    })
  })

  it('shares an active session check without caching authorization for later focus events', async () => {
    await act(async () => {
      root.render(<App />)
    })
    await act(async () => {
      window.dispatchEvent(new dom.window.Event('focus'))
      window.dispatchEvent(new dom.window.Event('focus'))
    })
    expect(sessionRequests).toHaveLength(1)

    await act(async () => {
      sessionRequests[0](Response.json({ userId, username: 'alice', deviceId: 'device' }))
    })
    await act(async () => {
      window.dispatchEvent(new dom.window.Event('focus'))
    })
    expect(sessionRequests).toHaveLength(2)
  })

  it('keeps the current chat offline, skips focus requests, and validates the session on reconnect', async () => {
    let online = true
    vi.spyOn(dom.window.navigator, 'onLine', 'get').mockImplementation(() => online)
    await act(async () => {
      root.render(<App />)
    })
    await act(async () => {
      sessionRequests[0](Response.json({ userId, username: 'alice', deviceId: 'device' }))
      sockets[0]?.open()
    })
    const workspace = container.querySelector('.workspace')
    expect(workspace).not.toBeNull()
    paths = []
    await act(async () => {
      online = false
      window.dispatchEvent(new dom.window.Event('offline'))
      window.dispatchEvent(new dom.window.Event('focus'))
    })
    expect(container.querySelector('.workspace')).toBe(workspace)
    expect(container.textContent).toContain('Waiting for network')
    expect(container.querySelector('.toast')).toBeNull()
    expect(paths).toEqual([])
    expect(sessionRequests).toHaveLength(1)
    await act(async () => {
      online = true
      window.dispatchEvent(new dom.window.Event('online'))
    })
    expect(sessionRequests).toHaveLength(2)
    await act(async () => {
      sessionRequests[1](Response.json({ message: 'Unauthorized' }, { status: 401 }))
    })
    expect(container.querySelector('h1')?.textContent).toBe('Welcome back')
  })

  it('waits offline on startup and restores automatically without showing the sign-in form', async () => {
    let online = false
    vi.spyOn(dom.window.navigator, 'onLine', 'get').mockImplementation(() => online)
    await act(async () => {
      root.render(<App />)
    })
    expect(sessionRequests).toHaveLength(0)
    expect(container.textContent).toContain("You're offline")
    expect(container.querySelector('form')).toBeNull()
    await act(async () => {
      online = true
      window.dispatchEvent(new dom.window.Event('online'))
    })
    expect(sessionRequests).toHaveLength(1)
    await act(async () => {
      sessionRequests[0](Response.json({ userId, username: 'alice', deviceId: 'device' }))
    })
    expect(container.querySelector('.workspace')).not.toBeNull()
  })

  it('rechecks after reconnect without waiting for an old session request or accepting its late response', async () => {
    let online = true
    vi.spyOn(dom.window.navigator, 'onLine', 'get').mockImplementation(() => online)
    await act(async () => {
      root.render(<App />)
    })
    await act(async () => {
      sessionRequests[0](Response.json({ userId, username: 'alice', deviceId: 'device' }))
    })
    await act(async () => {
      window.dispatchEvent(new dom.window.Event('focus'))
    })
    expect(sessionRequests).toHaveLength(2)
    await act(async () => {
      online = false
      window.dispatchEvent(new dom.window.Event('offline'))
    })
    await act(async () => {
      online = true
      window.dispatchEvent(new dom.window.Event('online'))
    })
    expect(sessionRequests).toHaveLength(3)
    await act(async () => {
      sessionRequests[2](Response.json({ userId, username: 'alice', deviceId: 'device' }))
      sessionRequests[1](Response.json({ message: 'Old authorization' }, { status: 401 }))
    })
    expect(container.querySelector('.workspace')).not.toBeNull()
    expect(container.querySelector('.toast')).toBeNull()
  })

  it('checks fresh session state after logout races an older focus response', async () => {
    await act(async () => {
      root.render(<App />)
    })
    await act(async () => {
      sessionRequests[0](Response.json({ userId, username: 'alice', deviceId: 'device' }))
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Main menu"]')!.click()
    })
    await act(async () => {
      ;[...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
        .find((item) => item.textContent === 'Sign out')!
        .click()
    })
    expect(logoutRequests).toHaveLength(1)
    await act(async () => {
      window.dispatchEvent(new dom.window.Event('focus'))
    })
    expect(sessionRequests).toHaveLength(2)

    await act(async () => {
      logoutRequests[0](new Response(null, { status: 204 }))
    })
    expect(sessionRequests).toHaveLength(3)
    await act(async () => {
      sessionRequests[2](Response.json({ message: 'Unauthorized' }, { status: 401 }))
    })
    expect(container.querySelector('h1')?.textContent).toBe('Welcome back')

    await act(async () => {
      sessionRequests[1](Response.json({ userId, username: 'alice', deviceId: 'device' }))
    })
    expect(container.querySelector('h1')?.textContent).toBe('Welcome back')
  })

  it('shares an in-flight chat refresh and follows an event burst with one fresh read', async () => {
    holdChatRequests = true
    await renderMessenger()
    await act(async () => {
      sockets[0].open()
      chatCreated(sockets[0], '01ARZ3NDEKTSV4RRFFQ69G5FAX')
      chatCreated(sockets[0], '01ARZ3NDEKTSV4RRFFQ69G5FAY')
      chatCreated(sockets[0], '01ARZ3NDEKTSV4RRFFQ69G5FAZ')
    })
    expect(chatRequests).toHaveLength(1)
    const shared = messenger.refreshChats()
    expect(messenger.refreshChats()).toBe(shared)

    await act(async () => {
      chatRequests[0](Response.json({ chats: [group], nextCursor: null }))
    })
    expect(chatRequests).toHaveLength(2)
    await act(async () => {
      chatRequests[1](Response.json({ chats: [group], nextCursor: null }))
    })
    expect(chatRequests).toHaveLength(2)
    expect(container.textContent).toBe('Group')
  })

  it('renews the selected group once after coalesced chat-created events', async () => {
    window.history.replaceState(null, '', `/groups/${chatId}`)
    await renderMessenger()
    await act(async () => {
      sockets[0].open()
    })
    holdChatRequests = true
    await act(async () => {
      chatCreated(sockets[0], '01ARZ3NDEKTSV4RRFFQ69G5FAX')
      chatCreated(sockets[0], '01ARZ3NDEKTSV4RRFFQ69G5FAY')
      chatCreated(sockets[0], '01ARZ3NDEKTSV4RRFFQ69G5FAZ')
    })
    await act(async () => {
      chatRequests[0](Response.json({ chats: [group], nextCursor: null }))
    })
    await act(async () => {
      chatRequests[1](Response.json({ chats: [group], nextCursor: null }))
    })

    expect(
      sockets[0].sent.filter((data) => JSON.parse(data).type === 'subscribe_many'),
    ).toHaveLength(2)
  })

  it('does not renew a replacement socket when an older socket refresh completes', async () => {
    vi.useFakeTimers()
    window.history.replaceState(null, '', `/groups/${chatId}`)
    await renderMessenger()
    await act(async () => {
      sockets[0].open()
    })
    holdChatRequests = true
    await act(async () => {
      chatCreated(sockets[0], '01ARZ3NDEKTSV4RRFFQ69G5FAX')
    })
    await act(async () => {
      sockets[0].close()
      await vi.advanceTimersByTimeAsync(1000)
      sockets[1].open()
    })
    await act(async () => {
      chatRequests[0](Response.json({ chats: [group], nextCursor: null }))
    })

    expect(
      sockets[1].sent.filter((data) => JSON.parse(data).type === 'subscribe_many'),
    ).toHaveLength(1)
  })

  it('checks chat state on a sequence gap and once a minute instead of polling each feature', async () => {
    vi.useFakeTimers()
    window.history.replaceState(null, '', `/groups/${chatId}`)
    await renderMessenger()
    await act(async () => {
      sockets[0].open()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    const head = BigInt(snapshotFor(chatId).snapshotSequence)
    const pinsChanged = (seq: bigint, eventId: string) =>
      sockets[0].event({
        type: 'pins_changed',
        version: 1,
        eventId,
        room: `group:${chatId}`,
        epoch: 'epoch',
        streamId: '5-0',
        chatId,
        seq: String(seq),
      })
    paths = []

    await act(async () => pinsChanged(head + 1n, '01ARZ3NDEKTSV4RRFFQ69G5FB0'))
    expect(paths.filter((path) => path.split('?')[0].endsWith('/state'))).toHaveLength(0)

    await act(async () => pinsChanged(head + 3n, '01ARZ3NDEKTSV4RRFFQ69G5FB1'))
    expect(paths.filter((path) => path.split('?')[0].endsWith('/state'))).toHaveLength(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })

    paths = []
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000)
    })
    const routes = paths.map((path) => path.split('?')[0])
    for (const route of ['/reads', '/visibility', '/changes', '/pins'])
      expect(routes.filter((path) => path.endsWith(route))).toHaveLength(0)
    expect(routes.filter((path) => path.endsWith('/state'))).toHaveLength(2)
  })

  it('retries a failed pin load after the next state check and then stays quiet', async () => {
    vi.useFakeTimers()
    pinFailures = 1
    window.history.replaceState(null, '', `/groups/${chatId}`)
    paths = []
    await renderMessenger()
    await act(async () => {
      sockets[0].open()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    const pinLoads = () => paths.filter((path) => path.split('?')[0].endsWith('/pins')).length
    expect(pinLoads()).toBe(2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000)
    })
    expect(pinLoads()).toBe(2)
    pinFailures = 0
  })

  it('checks state after an own read without re-checking history visibility', async () => {
    vi.useFakeTimers()
    historyMessages = Array.from({ length: 3 }, (_, index) => ({
      id: String(index + 1).padStart(26, '0'),
      chatId,
      senderId: recipient.id,
      sequence: String(index + 1),
      body: `Message ${index + 1}`,
      createdAt: '2026-11-04T10:00:00Z',
    }))
    window.history.replaceState(null, '', `/groups/${chatId}`)
    await renderMessenger()
    await act(async () => {
      sockets[0].open()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    paths = []
    await act(async () => {
      sockets[0].event({
        type: 'reads_changed',
        version: 1,
        eventId: '01ARZ3NDEKTSV4RRFFQ69G5FB2',
        room: `user:${userId}`,
        epoch: 'epoch',
        streamId: '6-0',
        chatId,
        memberSeq: '1',
      })
      await vi.advanceTimersByTimeAsync(1000)
    })
    const routes = paths.map((path) => path.split('?')[0])
    expect(routes.filter((path) => path.endsWith('/state'))).toHaveLength(1)
    for (const route of ['/messages/resolve', '/messages', '/pins'])
      expect(routes.filter((path) => path.endsWith(route))).toHaveLength(0)
    stateMemberSeq = undefined
  })

  it('keeps a read hint that arrived during a primary check owed until a later primary check', async () => {
    vi.useFakeTimers()
    window.history.replaceState(null, '', `/groups/${chatId}`)
    await renderMessenger()
    await act(async () => {
      sockets[0].open()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    const readHint = (eventId: string, streamId: string) =>
      sockets[0].event({
        type: 'reads_changed',
        version: 1,
        eventId,
        room: `group:${chatId}`,
        epoch: 'epoch',
        streamId,
        chatId,
      })
    stateRequests = []
    holdState = true
    await act(async () => {
      readHint('01ARZ3NDEKTSV4RRFFQ69G5FB3', '7-0')
      await vi.advanceTimersByTimeAsync(10)
    })
    await act(async () => {
      readHint('01ARZ3NDEKTSV4RRFFQ69G5FB4', '8-0')
      await vi.advanceTimersByTimeAsync(10)
    })
    holdState = false
    await act(async () => {
      stateRequests[0].release?.()
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(stateRequests.map((request) => request.primary)).toEqual([true, true])
  })

  it('leaves a chat-list row alone when someone else reads', async () => {
    vi.useFakeTimers()
    await renderMessenger()
    await act(async () => {
      sockets[0].open()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    paths = []
    await act(async () => {
      sockets[0].event({
        type: 'reads_changed',
        version: 1,
        eventId: '01ARZ3NDEKTSV4RRFFQ69G5FB5',
        room: `user:${userId}`,
        epoch: 'epoch',
        streamId: '9-0',
        chatId,
      })
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(paths.filter((path) => path.endsWith(`/chats/${chatId}`))).toHaveLength(0)
  })

  it('still runs the queued primary check when the running one fails', async () => {
    vi.useFakeTimers()
    window.history.replaceState(null, '', `/groups/${chatId}`)
    await renderMessenger()
    await act(async () => {
      sockets[0].open()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    const readHint = (eventId: string, streamId: string) =>
      sockets[0].event({
        type: 'reads_changed',
        version: 1,
        eventId,
        room: `group:${chatId}`,
        epoch: 'epoch',
        streamId,
        chatId,
      })
    stateRequests = []
    holdState = true
    await act(async () => {
      readHint('01ARZ3NDEKTSV4RRFFQ69G5FB6', '10-0')
      await vi.advanceTimersByTimeAsync(10)
    })
    await act(async () => {
      readHint('01ARZ3NDEKTSV4RRFFQ69G5FB7', '11-0')
      await vi.advanceTimersByTimeAsync(10)
    })
    holdState = false
    await act(async () => {
      stateRequests[0].fail = true
      stateRequests[0].release?.()
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(stateRequests.length).toBeGreaterThan(1)
    expect(stateRequests.every((request) => request.primary)).toBe(true)
  })

  it('coalesces repeated focus work while the selected group is current', async () => {
    vi.useFakeTimers()
    window.history.replaceState(null, '', `/groups/${chatId}`)
    await renderMessenger()
    await act(async () => {
      sockets[0].open()
    })
    paths = []

    await act(async () => {
      window.dispatchEvent(new dom.window.Event('focus'))
      window.dispatchEvent(new dom.window.Event('focus'))
    })
    await act(async () => {
      window.dispatchEvent(new dom.window.Event('focus'))
    })

    expect(paths.filter((path) => path.endsWith('/chats'))).toHaveLength(1)
    expect(paths.filter((path) => path.endsWith('/messages'))).toHaveLength(1)
  })

  it('retries focus reads after a failed refresh instead of treating stale data as fresh', async () => {
    vi.useFakeTimers()
    await renderMessenger()
    await act(async () => {
      sockets[0].open()
    })
    paths = []
    failChatRequest = true

    await act(async () => {
      window.dispatchEvent(new dom.window.Event('focus'))
    })
    await act(async () => {
      window.dispatchEvent(new dom.window.Event('focus'))
    })

    expect(paths.filter((path) => path.endsWith('/chats'))).toHaveLength(2)
  })

  it('retries failed history on focus even while chat metadata is current', async () => {
    vi.useFakeTimers()
    window.history.replaceState(null, '', `/groups/${chatId}`)
    await renderMessenger()
    await act(async () => {
      sockets[0].open()
    })
    paths = []
    failHistoryRequest = true

    await act(async () => {
      window.dispatchEvent(new dom.window.Event('focus'))
    })
    await act(async () => {
      window.dispatchEvent(new dom.window.Event('focus'))
    })

    expect(paths.filter((path) => path.endsWith('/messages'))).toHaveLength(2)
  })

  it('runs required history recovery after reconnect despite fresh focus data', async () => {
    vi.useFakeTimers()
    window.history.replaceState(null, '', `/groups/${chatId}`)
    await renderMessenger()
    await act(async () => {
      sockets[0].open()
    })
    await act(async () => {
      window.dispatchEvent(new dom.window.Event('focus'))
    })
    paths = []

    await act(async () => {
      sockets[0].close()
      await vi.advanceTimersByTimeAsync(1000)
      sockets[1].open()
    })

    expect(paths.filter((path) => path.endsWith('/messages'))).toHaveLength(1)
    paths = []
    await act(async () => {
      window.dispatchEvent(new dom.window.Event('focus'))
    })
    expect(paths.filter((path) => path.endsWith('/messages'))).toHaveLength(1)
  })

  it('flushes applied progress when the page is hidden', async () => {
    vi.useFakeTimers()
    window.history.replaceState(null, '', `/groups/${chatId}`)
    await renderMessenger()
    await act(async () => {
      sockets[0].open()
    })
    sockets[0].sent = []
    await act(async () => {
      sockets[0].event({
        type: 'message_saved',
        version: 1,
        eventId: '01ARZ3NDEKTSV4RRFFQ69G5FAX',
        room: `group:${chatId}`,
        epoch: 'epoch',
        streamId: '1-0',
        chatId,
        requestId: '01ARZ3NDEKTSV4RRFFQ69G5FAY',
        messageId: '01ARZ3NDEKTSV4RRFFQ69G5FAZ',
        sequence: '1',
        senderId: userId,
        body: 'hello',
        createdAt: '2026-01-01T00:00:00Z',
      })
    })
    expect(sockets[0].sent).toEqual([])
    await act(async () => {
      window.dispatchEvent(new dom.window.Event('pagehide'))
    })
    expect(sockets[0].sent.map((data) => JSON.parse(data))).toEqual([
      { type: 'applied', version: 1, chatId, sequence: '1', epoch: 'epoch', streamId: '1-0' },
    ])
    expect(localStorage.getItem(`relay.${userId}.device.resolved-cursor.v2`)).toBe(
      JSON.stringify({ [chatId]: '1' }),
    )
  })
})
