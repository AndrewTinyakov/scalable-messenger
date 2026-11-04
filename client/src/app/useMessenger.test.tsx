import { JSDOM } from 'jsdom'
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
let readCalls: string[]
let visibilityRevision: string
let clearedThrough: string
let hidden: boolean

function snapshotFor(id: string) {
  return {
    snapshotSequence:
      historyMessages.filter((message) => message.chatId === id).at(-1)?.sequence ?? '0',
    mutationRevision: '0',
    visibilityRevision,
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
  readCalls = []
  visibilityRevision = '0'
  clearedThrough = '0'
  hidden = false
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
    const path = new URL(input, 'http://localhost').pathname
    paths.push(path)
    const requestedChat = path.split('/chats/')[1]?.split('/')[0] ?? chatId
    const metadata = snapshotFor(requestedChat)
    if (path.endsWith('/visibility')) return Response.json({ ...metadata, hidden })
    if (path.endsWith('/changes'))
      return Response.json({
        ...metadata,
        mutationRevision: undefined,
        changes: [],
        lastRevision: '0',
        nextRevision: '0',
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
        return Response.json({ message: 'Unavailable' }, { status: 503 })
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
      return Response.json({ ...group, memberCount: groupMemberCount, members: groupMembers })
    if (path.endsWith('/chats')) {
      if (failChatRequest) {
        failChatRequest = false
        return Response.json({ message: 'Unavailable' }, { status: 503 })
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
      chatRequests[0](Response.json({ message: 'Failed to fetch' }, { status: 503 }))
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
    visibilityRevision = '1'
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
        mutationRevision: '0',
        visibilityRevision: '1',
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
  it('reads visible rows after a background burst through the actual socket, messenger and panel callers', async () => {
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
  })
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

  it('coalesces repeated focus work while the selected group is current', async () => {
    vi.useFakeTimers()
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
