import { useCallback, useEffect, useRef, useState } from 'react'
import type { Chat } from '../entities/chat/model'
import { advanceSend, type Message, type PendingSend, type SendState } from '../entities/message/model'
import {
  advanceAppliedSequence, appendLiveWindow, hasMoreNewer, hasNewAppliedMessages, hasUnresolvedGap,
  historyBoundaryBefore, HISTORY_PAGE_SIZE,
  MAX_CATCH_UP_MESSAGES, pageWindow, replaceWindow,
} from '../entities/message/historyWindow'
import type { Session, User } from '../entities/session/model'
import { ApiError, api } from '../shared/api/http'
import { createUlid } from '../shared/lib/id'
import { reconnectDelay } from '../shared/lib/reconnect'

type Connection = 'connecting' | 'connected' | 'offline'
type MessageMap = Record<string, Message[]>
type CursorMap = Record<string, string>
type RoomCursor = { epoch: string; streamId: string }
type RoomCursorMap = Record<string, RoomCursor>
const MAX_REJECTED_SENDS = 100
const MAX_UNRESOLVED_SENDS = 100
const SEND_STATUS_BATCH_SIZE = 100

function retainPending(sends: PendingSend[]): PendingSend[] {
  const recentRejections = new Set(sends.filter((send) => send.status === 'rejected').slice(-MAX_REJECTED_SENDS).map((send) => send.requestId))
  return sends.filter((send) => send.status !== 'saved' && (send.status !== 'rejected' || recentRejections.has(send.requestId)))
}

function readStored<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key)
    return value ? JSON.parse(value) as T : fallback
  } catch {
    return fallback
  }
}

function writeStored(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* Local storage may be full or disabled. */ }
}

function websocketUrl(): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${location.host}/ws`
}

interface SocketFrame {
  type?: string
  event?: SocketFrame
  payload?: SocketFrame
  chatId?: string
  recipientId?: string
  requestId?: string
  messageId?: string
  sequence?: string
  senderId?: string
  body?: string
  createdAt?: string
  reason?: string
  code?: string
  epoch?: string
  streamId?: string
  room?: string
}

function unwrap(frame: SocketFrame): SocketFrame {
  if (frame.type === 'event' && (frame.event || frame.payload)) {
    return { ...frame, ...(frame.event || frame.payload) }
  }
  return frame
}

function socketErrorMessage(code?: string): string {
  switch (code) {
    case 'rate_limited': return 'Sending too quickly. Wait a moment and try again.'
    case 'unauthorized': return 'You can no longer send to this chat.'
    case 'room_limit': return 'Too many active chats. Try again shortly.'
    case 'publish_unknown': return 'Queue confirmation was lost. Check status before retrying.'
    case 'dependency_unavailable': return 'The message service is unavailable. Try again.'
    case 'publish_failed': return 'The message could not be queued. Try again.'
    default: return 'Could not queue this message. Try again.'
  }
}

function newerStreamId(next: string, current: string): boolean {
  const [nextTime, nextSequence] = next.split('-').map(BigInt)
  const [currentTime, currentSequence] = current.split('-').map(BigInt)
  return nextTime > currentTime || (nextTime === currentTime && nextSequence > currentSequence)
}

export function useMessenger(session: Session, onSessionRevoked: () => void) {
  const prefix = `relay.${session.user.id}.${session.deviceId}`
  const [chats, setChats] = useState<Chat[]>([])
  const [nextChatCursor, setNextChatCursor] = useState<string | null>(null)
  const [loadingMoreChats, setLoadingMoreChats] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState<string | null>(null)
  const [loadingNewer, setLoadingNewer] = useState<string | null>(null)
  const [messages, setMessages] = useState<MessageMap>({})
  const [latestSequences, setLatestSequences] = useState<CursorMap>({})
  const [jumpRevision, setJumpRevision] = useState(0)
  const [pending, setPending] = useState<PendingSend[]>(() => retainPending(readStored(`${prefix}.pending`, [])))
  const [connection, setConnection] = useState<Connection>('connecting')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draftChat, setDraftChat] = useState<Chat | undefined>()
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const socketRef = useRef<WebSocket | null>(null)
  const wsTicketRef = useRef<{ token: string; expiresAt: number } | null>(null)
  const groupRetryRef = useRef<number | undefined>(undefined)
  const groupRetryAttemptsRef = useRef(0)
  const chatsRef = useRef(chats)
  const messagesRef = useRef(messages)
  const latestRef = useRef<CursorMap>({})
  const pendingRef = useRef(pending)
  const reconcilingPendingRef = useRef(false)
  const pendingPollFailuresRef = useRef(0)
  const nextPendingPollAtRef = useRef(0)
  // Resolved includes messages applied in order and intervals explicitly dismissed by the user.
  // The old cursor key could have skipped unseen history, so it is not migrated.
  const cursorRef = useRef<CursorMap>(readStored(`${prefix}.resolved-cursor.v2`, {}))
  const dismissedThroughRef = useRef<CursorMap>(readStored(`${prefix}.dismissed-through.v2`, {}))
  const roomCursorRef = useRef<RoomCursorMap>(readStored(`${prefix}.room-cursor.v2`, {}))
  const catchupRef = useRef(new Set<string>())
  const catchupCallbackRef = useRef<((chatId: string, fromStart?: boolean) => Promise<void>) | null>(null)
  const catchupRetryRef = useRef<{ chatId: string; attempt: number; timer?: number } | null>(null)
  const catchupErrorRef = useRef<{ chatId: string; message: string } | null>(null)
  const deferredGapRef = useRef(new Set<string>())
  const pagingRef = useRef(new Set<string>())
  const detachedWindowRef = useRef(new Set<string>())
  const readingHistoryRef = useRef(new Set<string>())
  const removedChatRef = useRef(new Set<string>())
  const removalGenerationRef = useRef(0)
  const selectedRef = useRef<string | null>(null)
  const subscribedRef = useRef<string | null>(null)

  useEffect(() => {
    try { localStorage.removeItem(`${prefix}.messages`) } catch { /* Storage may be disabled. */ }
    writeStored(`${prefix}.pending`, pendingRef.current)
  }, [prefix])

  useEffect(() => {
    const next = Object.fromEntries(Object.entries(messagesRef.current).map(([id, items]) => [id, id === selectedId ? items : items.slice(-1)]))
    messagesRef.current = next
    setMessages(next)
  }, [selectedId])

  const updatePending = useCallback((requestId: string, status: SendState, extra: Partial<PendingSend> = {}) => {
    const next = retainPending(pendingRef.current.map((send) => send.requestId === requestId ? advanceSend(send, status, extra) : send))
    pendingRef.current = next
    setPending(next)
    writeStored(`${prefix}.pending`, next)
  }, [prefix])

  const recordLatest = useCallback((chatId: string, sequence: string) => {
    if (BigInt(sequence) <= BigInt(latestRef.current[chatId] || '0')) return
    latestRef.current = { ...latestRef.current, [chatId]: sequence }
    setLatestSequences(latestRef.current)
  }, [])

  const advanceCursor = useCallback((chatId: string, incoming: Message[]) => {
    const current = cursorRef.current[chatId] || '0'
    const next = advanceAppliedSequence(current, incoming)
    if (next === current) return
    cursorRef.current = { ...cursorRef.current, [chatId]: next }
    writeStored(`${prefix}.resolved-cursor.v2`, cursorRef.current)
    if (BigInt(next) >= BigInt(latestRef.current[chatId] || '0')) deferredGapRef.current.delete(chatId)
  }, [prefix])

  const dismissThrough = useCallback((chatId: string, sequence: string) => {
    if (BigInt(sequence) <= BigInt(cursorRef.current[chatId] || '0')) return
    dismissedThroughRef.current = { ...dismissedThroughRef.current, [chatId]: sequence }
    writeStored(`${prefix}.dismissed-through.v2`, dismissedThroughRef.current)
    cursorRef.current = { ...cursorRef.current, [chatId]: sequence }
    writeStored(`${prefix}.resolved-cursor.v2`, cursorRef.current)
    deferredGapRef.current.delete(chatId)
    const chat = chatsRef.current.find((item) => item.id === chatId)
    const room = chat?.kind === 'group' ? `group:${chatId}` : `user:${session.user.id}`
    const { [room]: _discarded, ...remaining } = roomCursorRef.current
    roomCursorRef.current = remaining
    writeStored(`${prefix}.room-cursor.v2`, roomCursorRef.current)
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'dismissed', version: 1, chatId, sequence }))
    }
  }, [prefix, session.user.id])

  const applyMessages = useCallback((chatId: string, incoming: Message[]) => {
    if (!incoming.length || removedChatRef.current.has(chatId)) return
    const current = messagesRef.current[chatId] || []
    const browsingOlder = selectedRef.current === chatId && (detachedWindowRef.current.has(chatId) || readingHistoryRef.current.has(chatId))
    let visible = current
    const incorporated: Message[] = []
    for (const message of incoming) {
      const next = selectedRef.current === chatId
        ? appendLiveWindow(visible, message, browsingOlder)
        : !visible.length || BigInt(message.sequence) >= BigInt(visible.at(-1)!.sequence) ? [message] : visible
      if (next !== visible) incorporated.push(message)
      visible = next
    }
    const highest = incoming.reduce((value, message) => BigInt(message.sequence) > BigInt(value) ? message.sequence : value, '0')
    recordLatest(chatId, highest)
    messagesRef.current = { ...messagesRef.current, [chatId]: visible }
    setMessages(messagesRef.current)
    advanceCursor(chatId, incorporated)
  }, [advanceCursor, recordLatest])

  const fetchLatest = useCallback(async (chatId: string, moveViewport = false, initialize = false) => {
    const result = await api.latestMessages(session.token, chatId)
    if (removedChatRef.current.has(chatId)) return { latest: undefined, messages: [] as Message[] }
    const visible = replaceWindow(result.messages)
    const current = messagesRef.current[chatId] || []
    const fetchedLatest = result.messages.at(-1)?.sequence
    const currentLatest = current.at(-1)?.sequence
    const keepNewerCurrent = Boolean(currentLatest && fetchedLatest && BigInt(currentLatest) > BigInt(fetchedLatest))
    const shown = keepNewerCurrent ? current : visible
    const replaced = (moveViewport || current.length === 0) && !keepNewerCurrent
    if (replaced) {
      messagesRef.current = { ...messagesRef.current, [chatId]: visible }
      setMessages(messagesRef.current)
      detachedWindowRef.current.delete(chatId)
    }
    const latest = keepNewerCurrent ? currentLatest : fetchedLatest
    if (latest) recordLatest(chatId, latest)
    if (initialize && !cursorRef.current[chatId] && shown.length) {
      // Opening an existing chat on a new device starts at its newest page.
      // Resolve only the older, unseen prefix; the fetched page is applied below.
      const boundary = historyBoundaryBefore(shown)
      if (BigInt(boundary) > 0n) dismissThrough(chatId, boundary)
    }
    if (replaced || initialize) advanceCursor(chatId, shown)
    if (latest && BigInt(latest) > BigInt(cursorRef.current[chatId] || '0')) deferredGapRef.current.add(chatId)
    if (moveViewport) setJumpRevision((value) => value + 1)
    return { latest: shown.at(-1)?.sequence, messages: shown }
  }, [advanceCursor, dismissThrough, recordLatest, session.token])

  const showLatest = useCallback(async (chatId: string) => {
    const beforeJump = BigInt(cursorRef.current[chatId] || '0')
    const page = await fetchLatest(chatId, true)
    const latest = page.latest
    readingHistoryRef.current.delete(chatId)
    if (!latest) return
    if (BigInt(latest) <= BigInt(cursorRef.current[chatId] || '0')) {
      const applied = cursorRef.current[chatId]
      if (applied && hasNewAppliedMessages(beforeJump.toString(), applied, dismissedThroughRef.current[chatId] || '0') && socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: 'applied', version: 1, chatId, sequence: applied }))
      }
      return
    }
    // Dismiss only the unseen prefix. The fetched tail is applied in order.
    dismissThrough(chatId, historyBoundaryBefore(page.messages))
    advanceCursor(chatId, page.messages)
    const applied = cursorRef.current[chatId]
    if (applied && hasNewAppliedMessages(beforeJump.toString(), applied, dismissedThroughRef.current[chatId] || '0') && socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'applied', version: 1, chatId, sequence: applied }))
    }
  }, [advanceCursor, dismissThrough, fetchLatest])

  const loadOlder = useCallback(async (chatId: string) => {
    const first = messagesRef.current[chatId]?.[0]
    if (!first || first.sequence === '1' || pagingRef.current.has(chatId)) return
    pagingRef.current.add(chatId)
    setLoadingOlder(chatId)
    try {
      const page = await api.olderMessages(session.token, chatId, first.sequence, HISTORY_PAGE_SIZE)
      if (removedChatRef.current.has(chatId)) return
      if (messagesRef.current[chatId]?.[0]?.sequence !== first.sequence) return
      const visible = pageWindow(messagesRef.current[chatId] || [], page.messages, 'older')
      if (visible.at(-1)?.sequence !== messagesRef.current[chatId]?.at(-1)?.sequence) detachedWindowRef.current.add(chatId)
      messagesRef.current = { ...messagesRef.current, [chatId]: visible }
      setMessages(messagesRef.current)
      advanceCursor(chatId, visible)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load older messages')
    } finally {
      pagingRef.current.delete(chatId)
      setLoadingOlder(null)
    }
  }, [advanceCursor, session.token])

  const loadNewer = useCallback(async (chatId: string) => {
    const last = messagesRef.current[chatId]?.at(-1)
    if (!last || pagingRef.current.has(chatId)) return
    pagingRef.current.add(chatId)
    setLoadingNewer(chatId)
    try {
      const page = await api.messages(session.token, chatId, last.sequence, HISTORY_PAGE_SIZE)
      if (removedChatRef.current.has(chatId)) return
      if (messagesRef.current[chatId]?.at(-1)?.sequence !== last.sequence) return
      const visible = pageWindow(messagesRef.current[chatId] || [], page.messages, 'newer')
      messagesRef.current = { ...messagesRef.current, [chatId]: visible }
      setMessages(messagesRef.current)
      advanceCursor(chatId, visible)
      const end = page.messages.at(-1)?.sequence
      if (end) recordLatest(chatId, page.hasMore ? (BigInt(end) + 1n).toString() : end)
      if (!hasMoreNewer(visible, latestRef.current[chatId] || '0')) detachedWindowRef.current.delete(chatId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load newer messages')
    } finally {
      pagingRef.current.delete(chatId)
      setLoadingNewer(null)
    }
  }, [advanceCursor, recordLatest, session.token])

  const catchUp = useCallback(async (chatId: string, fromStart = false) => {
    if (catchupRef.current.has(chatId)) return
    catchupRef.current.add(chatId)
    const beforeCatchUp = BigInt(cursorRef.current[chatId] || '0')
    try {
      if (fromStart || !cursorRef.current[chatId]) {
        await fetchLatest(chatId, fromStart, !cursorRef.current[chatId])
      } else if (selectedRef.current === chatId &&
        (detachedWindowRef.current.has(chatId) || readingHistoryRef.current.has(chatId))) {
        await fetchLatest(chatId)
      } else if (deferredGapRef.current.has(chatId) ||
        BigInt(latestRef.current[chatId] || '0') - BigInt(cursorRef.current[chatId]) > BigInt(MAX_CATCH_UP_MESSAGES)) {
        deferredGapRef.current.add(chatId)
        await fetchLatest(chatId)
      } else {
        let after = cursorRef.current[chatId]
        for (let page = 0; page < MAX_CATCH_UP_MESSAGES / HISTORY_PAGE_SIZE; page += 1) {
          if (BigInt(cursorRef.current[chatId] || '0') > BigInt(after)) break
          const result = await api.messages(session.token, chatId, after, HISTORY_PAGE_SIZE)
          if (removedChatRef.current.has(chatId)) break
          if (BigInt(cursorRef.current[chatId] || '0') > BigInt(after)) break
          applyMessages(chatId, result.messages)
          if (!result.hasMore || result.messages.length === 0) break
          if (BigInt(result.nextSequence) <= BigInt(after)) throw new Error('History cursor did not advance')
          after = result.nextSequence
          if (page === MAX_CATCH_UP_MESSAGES / HISTORY_PAGE_SIZE - 1) {
            deferredGapRef.current.add(chatId)
            await fetchLatest(chatId)
          }
        }
      }
      const sequence = cursorRef.current[chatId]
      if (sequence && hasNewAppliedMessages(beforeCatchUp.toString(), sequence, dismissedThroughRef.current[chatId] || '0') &&
        socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: 'applied', version: 1, chatId, sequence }))
      }
      if (catchupRetryRef.current?.chatId === chatId) {
        window.clearTimeout(catchupRetryRef.current.timer)
        catchupRetryRef.current = null
      }
      if (catchupErrorRef.current?.chatId === chatId) {
        const recoveredError = catchupErrorRef.current.message
        catchupErrorRef.current = null
        setError((current) => current === recoveredError ? null : current)
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Could not load chat history'
      catchupErrorRef.current = { chatId, message }
      setError(message)
      if (selectedRef.current === chatId && socketRef.current?.readyState === WebSocket.OPEN) {
        const prior = catchupRetryRef.current
        if (!(prior?.chatId === chatId && prior.timer !== undefined)) {
          const attempt = prior?.chatId === chatId ? prior.attempt + 1 : 1
          const timer = window.setTimeout(() => {
            const retry = catchupRetryRef.current
            if (!retry || retry.chatId !== chatId) return
            retry.timer = undefined
            if (selectedRef.current === chatId && socketRef.current?.readyState === WebSocket.OPEN) {
              void catchupCallbackRef.current?.(chatId)
            }
          }, reconnectDelay(attempt))
          catchupRetryRef.current = { chatId, attempt, timer }
        }
      }
    } finally {
      catchupRef.current.delete(chatId)
    }
  }, [applyMessages, fetchLatest, session.token])
  catchupCallbackRef.current = catchUp

  useEffect(() => {
    const retry = catchupRetryRef.current
    if (retry && retry.chatId !== selectedId) {
      window.clearTimeout(retry.timer)
      catchupRetryRef.current = null
    }
  }, [selectedId])

  const refreshChats = useCallback(async (full = false) => {
    try {
      const removalGeneration = removalGenerationRef.current
      const previouslyLoaded = chatsRef.current
      const target = full ? Math.max(100, previouslyLoaded.length) : 100
      const list: Chat[] = []
      const seen = new Set<string>()
      let cursor: string | null = null
      do {
        const page = await api.chats(session.token, cursor || undefined)
        for (const chat of page.chats) {
          if (seen.has(chat.id)) continue
          seen.add(chat.id)
          list.push(chat)
        }
        cursor = page.nextCursor
      } while (cursor && list.length < target)
      const current = previouslyLoaded.find((chat) => chat.id === selectedRef.current)
      let removedSelected = false
      if (current && !seen.has(current.id)) {
        try {
          list.push(await api.chat(session.token, current.id))
          seen.add(current.id)
        } catch (cause) {
          removedSelected = cause instanceof ApiError && cause.status === 404
          if (!removedSelected) { list.push(current); seen.add(current.id) }
        }
      }
      const fresh = list.filter((chat) => !removedChatRef.current.has(chat.id) || removalGeneration === removalGenerationRef.current)
        .map((chat) => chat.id === current?.id && chat.kind === 'group' && current.members.length > 0
        ? { ...chat, members: current.members }
        : chat)
      for (const chat of fresh) removedChatRef.current.delete(chat.id)
      const merged = full ? fresh : [
        ...fresh,
        ...previouslyLoaded.filter((chat) => !seen.has(chat.id) && !removedChatRef.current.has(chat.id) && !(removedSelected && chat.id === current?.id)),
      ]
      chatsRef.current = merged
      setChats(merged)
      for (const chat of fresh) recordLatest(chat.id, chat.lastSequence)
      if (full || previouslyLoaded.length === 0) setNextChatCursor(cursor)
      setSelectedId((current) => {
        if (current?.startsWith('draft:')) {
          const recipientId = current.slice(6)
          return merged.find((chat) => chat.kind === 'direct' && chat.members.some((member) => member.id === recipientId))?.id || current
        }
        return current && merged.some((item) => item.id === current) ? current : merged[0]?.id || null
      })
      setError(null)
      return merged
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load chats')
      return []
    } finally {
      setLoading(false)
    }
  }, [recordLatest, session.token])

  const loadMoreChats = useCallback(async () => {
    if (!nextChatCursor || loadingMoreChats) return
    setLoadingMoreChats(true)
    try {
      const page = await api.chats(session.token, nextChatCursor)
      const known = new Set(chatsRef.current.map((chat) => chat.id))
      const merged = [...chatsRef.current, ...page.chats.filter((chat) => !known.has(chat.id))]
      chatsRef.current = merged
      setChats(merged)
      for (const chat of page.chats) recordLatest(chat.id, chat.lastSequence)
      setNextChatCursor(page.nextCursor)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load more chats')
    } finally {
      setLoadingMoreChats(false)
    }
  }, [loadingMoreChats, nextChatCursor, recordLatest, session.token])

  useEffect(() => {
    const chat = chats.find((item) => item.id === selectedId)
    if (!chat || chat.kind !== 'group' || chat.members.length > 0) return
    let active = true
    void api.chat(session.token, chat.id).then((opened) => {
      if (!active) return
      const next = chatsRef.current.map((item) => item.id === opened.id ? { ...item, members: opened.members } : item)
      chatsRef.current = next
      setChats(next)
    }).catch(() => { /* A later chat refresh or selection retries. */ })
    return () => { active = false }
  }, [chats, selectedId, session.token])

  useEffect(() => { void refreshChats() }, [refreshChats])

  const reconcilePending = useCallback(async (retryUnknown = false) => {
    if (reconcilingPendingRef.current || Date.now() < nextPendingPollAtRef.current) return
    reconcilingPendingRef.current = true
    try {
      const unresolved = pendingRef.current.filter((item) => item.status === 'sending' || item.status === 'retryable' || item.status === 'queued')
      const changedChats = new Set<string>()
      let refreshDirects = false
      for (let offset = 0; offset < unresolved.length; offset += SEND_STATUS_BATCH_SIZE) {
        const batch = unresolved.slice(offset, offset + SEND_STATUS_BATCH_SIZE)
        const results = await api.sendStatuses(session.token, batch.map((send) => send.requestId))
        const byId = new Map(results.map((entry) => [entry.requestId, entry.result]))
        const updates = new Map<string, { status: SendState; extra: Partial<PendingSend> }>()
        const resends: PendingSend[] = []
        for (const send of batch) {
          const result = byId.get(send.requestId)
          if (!result) throw new Error('Send status response is incomplete')
          if (result.status === 'saved') {
            if (!result.messageId || !result.chatId) throw new Error('Saved status is missing message details')
            updates.set(send.requestId, { status: 'saved', extra: { messageId: result.messageId, chatId: result.chatId } })
            changedChats.add(result.chatId)
            if (send.recipientId) {
              setSelectedId((current) => current === send.chatId ? result.chatId! : current)
              setDraftChat(undefined)
              refreshDirects = true
            }
          } else if (result.status === 'rejected') {
            updates.set(send.requestId, { status: 'rejected', extra: { reason: result.reason || 'The message could not be saved.' } })
          } else if (retryUnknown && (send.status === 'sending' || send.status === 'retryable') && socketRef.current?.readyState === WebSocket.OPEN) {
            updates.set(send.requestId, { status: 'sending', extra: { reason: undefined } })
            resends.push(send)
          }
        }
        if (updates.size > 0) {
          const next = retainPending(pendingRef.current.map((send) => {
            const update = updates.get(send.requestId)
            return update ? advanceSend(send, update.status, update.extra) : send
          }))
          pendingRef.current = next
          setPending(next)
          writeStored(`${prefix}.pending`, next)
        }
        for (const send of resends) {
          const current = pendingRef.current.find((item) => item.requestId === send.requestId)
          if (socketRef.current?.readyState !== WebSocket.OPEN) break
          if (!current || (current.status !== 'sending' && current.status !== 'retryable')) continue
          socketRef.current.send(JSON.stringify({
            type: 'send', version: 1, ...(send.recipientId ? { recipientId: send.recipientId } : { chatId: send.chatId }), requestId: send.requestId, body: send.body,
          }))
          await new Promise<void>((resolve) => { window.setTimeout(resolve, 60) })
        }
      }
      if (refreshDirects) await refreshChats()
      for (const chatId of changedChats) await catchUp(chatId)
      pendingPollFailuresRef.current = 0
      nextPendingPollAtRef.current = 0
    } catch {
      pendingPollFailuresRef.current++
      nextPendingPollAtRef.current = Date.now() + Math.min(30000 * 2 ** (pendingPollFailuresRef.current - 1), 120000)
    } finally {
      reconcilingPendingRef.current = false
    }
  }, [catchUp, prefix, refreshChats, session.token])

  const subscribeMany = useCallback((chatIds: string[]) => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) return
    const subscriptions = chatIds.map((chatId) => {
      const chat = chatsRef.current.find((item) => item.id === chatId)
      if (!chat) return null
      const room = chat.kind === 'group' ? `group:${chatId}` : `user:${session.user.id}`
      const dismissedThrough = dismissedThroughRef.current[chatId]
      if (dismissedThrough) socketRef.current?.send(JSON.stringify({ type: 'dismissed', version: 1, chatId, sequence: dismissedThrough }))
      return { chatId, kind: chat.kind, lastAppliedSequence: cursorRef.current[chatId] || '0', ...(roomCursorRef.current[room] || {}) }
    }).filter((item) => item !== null)
    for (let offset = 0; offset < subscriptions.length; offset += 10) {
      socketRef.current.send(JSON.stringify({ type: 'subscribe_many', version: 1, subscriptions: subscriptions.slice(offset, offset + 10) }))
    }
  }, [session.user.id])

  const subscribe = useCallback((chatId: string) => subscribeMany([chatId]), [subscribeMany])

  useEffect(() => {
    selectedRef.current = selectedId
    const socket = socketRef.current
    if (socket?.readyState !== WebSocket.OPEN) return
    if (subscribedRef.current && subscribedRef.current !== selectedId) {
      socket.send(JSON.stringify({ type: 'unsubscribe', version: 1, chatId: subscribedRef.current }))
      subscribedRef.current = null
    }
    if (selectedId && !selectedId.startsWith('draft:') && subscribedRef.current !== selectedId) {
      subscribe(selectedId)
      subscribedRef.current = selectedId
      void catchUp(selectedId, !(messagesRef.current[selectedId]?.length))
    }
  }, [selectedId, subscribe, catchUp])

  useEffect(() => {
    let timer: number
    const renew = () => {
      const active = selectedRef.current
      if (active && chatsRef.current.find((chat) => chat.id === active)?.kind === 'group') subscribe(active)
      timer = window.setTimeout(renew, (7 + Math.random()) * 60 * 1000)
    }
    timer = window.setTimeout(renew, (7 + Math.random()) * 60 * 1000)
    return () => window.clearTimeout(timer)
  }, [subscribe])

  useEffect(() => {
    let disposed = false
    let reconnectTimer: number | undefined
    let stableTimer: number | undefined
    let attempts = 0

    async function connect() {
      if (disposed) return
      setConnection('connecting')
      let wsTicket: string
      try {
        let ticket = wsTicketRef.current
        if (!ticket || ticket.expiresAt <= Date.now() / 1000 + 60) {
          ticket = await api.wsTicket(session.token)
          wsTicketRef.current = ticket
        }
        wsTicket = ticket.token
      }
      catch (error) {
        if (error instanceof ApiError && error.status === 401) { onSessionRevoked(); return }
        if (!disposed) { setConnection('offline'); reconnectTimer = window.setTimeout(() => { void connect() }, reconnectDelay(++attempts)) }
        return
      }
      if (disposed) return
      const socket = new WebSocket(websocketUrl(), ['messenger', `messenger-ticket.${wsTicket}`])
      socketRef.current = socket
      socket.onopen = () => {
        stableTimer = window.setTimeout(() => { attempts = 0 }, 30000)
        setConnection('connected')
        const active = selectedRef.current
        if (active && !active.startsWith('draft:')) { subscribe(active); subscribedRef.current = active; void catchUp(active) }
        void reconcilePending(true)
      }
      socket.onmessage = (event: MessageEvent<string>) => {
        let frame: SocketFrame
        try { frame = unwrap(JSON.parse(event.data) as SocketFrame) } catch { return }
        const kind = frame.type?.toLowerCase()
        if (kind === 'subscribed' && frame.chatId === selectedRef.current) {
          window.clearTimeout(groupRetryRef.current)
          groupRetryRef.current = undefined
          groupRetryAttemptsRef.current = 0
        } else if (kind === 'chat_created' && frame.chatId) {
          removedChatRef.current.delete(frame.chatId)
          void refreshChats().then((list) => {
            if (list.some((chat) => chat.id === frame.chatId)) {
              if (frame.chatId === selectedRef.current) { subscribe(frame.chatId!); void catchUp(frame.chatId!) }
            }
          })
        } else if (kind === 'queued' && frame.requestId) {
          updatePending(frame.requestId, 'queued')
        } else if ((kind === 'message_saved' || kind === 'saved' || kind === 'message') && frame.chatId && frame.messageId && frame.sequence && frame.senderId && typeof frame.body === 'string') {
          if (!chatsRef.current.some((item) => item.id === frame.chatId)) void refreshChats()
          const previous = BigInt(cursorRef.current[frame.chatId] || '0')
          const dismissedThrough = BigInt(dismissedThroughRef.current[frame.chatId] || '0')
          if (BigInt(frame.sequence) > dismissedThrough) {
            applyMessages(frame.chatId, [{
              id: frame.messageId,
              chatId: frame.chatId,
              sequence: frame.sequence,
              senderId: frame.senderId,
              body: frame.body,
              createdAt: frame.createdAt || new Date().toISOString(),
            }])
          }
          if (frame.requestId) {
            const matched = pendingRef.current.find((send) => send.requestId === frame.requestId)
            updatePending(frame.requestId, 'saved', { messageId: frame.messageId, chatId: frame.chatId })
            if (matched?.recipientId) {
              setSelectedId((current) => current === matched.chatId ? frame.chatId! : current)
              setDraftChat(undefined)
            }
          }
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({
            type: 'received_message', version: 1, chatId: frame.chatId, sequence: frame.sequence,
          }))
          const acknowledge = async () => {
            if (BigInt(frame.sequence!) <= dismissedThrough) return
            if (BigInt(frame.sequence!) > previous + 1n && !deferredGapRef.current.has(frame.chatId!)) await catchUp(frame.chatId!)
            if (BigInt(frame.sequence!) <= BigInt(dismissedThroughRef.current[frame.chatId!] || '0')) return
            if (BigInt(frame.sequence!) > BigInt(cursorRef.current[frame.chatId!] || '0')) return
            const chat = chatsRef.current.find((item) => item.id === frame.chatId)
            const room = frame.room || (chat?.kind === 'group' ? `group:${frame.chatId}` : `user:${session.user.id}`)
            if (frame.epoch && frame.streamId) {
              const previousRoom = roomCursorRef.current[room]
              if (!previousRoom || previousRoom.epoch !== frame.epoch || newerStreamId(frame.streamId, previousRoom.streamId)) {
                roomCursorRef.current = { ...roomCursorRef.current, [room]: { epoch: frame.epoch, streamId: frame.streamId } }
                writeStored(`${prefix}.room-cursor.v2`, roomCursorRef.current)
              }
            }
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({
              type: 'applied', version: 1, chatId: frame.chatId,
              sequence: cursorRef.current[frame.chatId!] || '0',
              ...(frame.epoch && frame.streamId ? { epoch: frame.epoch, streamId: frame.streamId } : {}),
            }))
          }
          void acknowledge()
        } else if ((kind === 'send_rejected' || kind === 'rejected') && frame.requestId) {
          updatePending(frame.requestId, 'rejected', { reason: frame.reason || 'The message could not be saved.' })
        } else if (kind === 'error' && frame.requestId) {
          updatePending(frame.requestId, 'retryable', { reason: frame.reason || socketErrorMessage(frame.code) })
        } else if (kind === 'error' && !frame.requestId && frame.code === 'unauthorized') {
          void refreshChats()
        } else if (kind === 'error' && !frame.requestId && frame.code === 'dependency_unavailable') {
          if (groupRetryRef.current === undefined) {
            groupRetryRef.current = window.setTimeout(() => {
              groupRetryRef.current = undefined
              const active = selectedRef.current
              if (active && chatsRef.current.find((chat) => chat.id === active)?.kind === 'group') subscribe(active)
            }, reconnectDelay(++groupRetryAttemptsRef.current))
          }
        } else if (kind === 'recovery_failed' && frame.chatId) {
          void catchUp(frame.chatId)
          void reconcilePending()
        } else if (kind === 'subscription_expired' && frame.chatId) {
          if (selectedRef.current === frame.chatId) { subscribedRef.current = null; subscribe(frame.chatId); void catchUp(frame.chatId) }
        } else if (kind === 'member_removed' && frame.chatId) {
          if (subscribedRef.current === frame.chatId) subscribedRef.current = null
          const removedId = frame.chatId
          removedChatRef.current.add(removedId)
          removalGenerationRef.current += 1
          const remainingChats = chatsRef.current.filter((chat) => chat.id !== removedId)
          chatsRef.current = remainingChats
          setChats(remainingChats)
          setSelectedId((current) => current === removedId ? remainingChats[0]?.id || null : current)
          const { [removedId]: _oldMessages, ...remainingMessages } = messagesRef.current
          messagesRef.current = remainingMessages
          setMessages(remainingMessages)
          const { [removedId]: _oldCursor, ...remainingCursors } = cursorRef.current
          cursorRef.current = remainingCursors
          writeStored(`${prefix}.resolved-cursor.v2`, remainingCursors)
          const { [removedId]: _oldDismissal, ...remainingDismissals } = dismissedThroughRef.current
          dismissedThroughRef.current = remainingDismissals
          writeStored(`${prefix}.dismissed-through.v2`, remainingDismissals)
          const { [removedId]: _oldLatest, ...remainingLatest } = latestRef.current
          latestRef.current = remainingLatest
          setLatestSequences(remainingLatest)
          const { [`group:${removedId}`]: _oldRoomCursor, ...remainingRoomCursors } = roomCursorRef.current
          roomCursorRef.current = remainingRoomCursors
          writeStored(`${prefix}.room-cursor.v2`, remainingRoomCursors)
          detachedWindowRef.current.delete(removedId)
          readingHistoryRef.current.delete(removedId)
          deferredGapRef.current.delete(removedId)
          void refreshChats()
        }
      }
      socket.onclose = (event: CloseEvent) => {
        window.clearTimeout(catchupRetryRef.current?.timer)
        catchupRetryRef.current = null
        window.clearTimeout(groupRetryRef.current)
        groupRetryRef.current = undefined
        subscribedRef.current = null
        window.clearTimeout(stableTimer)
        if (socketRef.current === socket) socketRef.current = null
        if (disposed) return
        if (event.code === 4003) { onSessionRevoked(); return }
        setConnection('offline')
        attempts += 1
        reconnectTimer = window.setTimeout(() => { void connect() }, reconnectDelay(attempts))
      }
      socket.onerror = () => socket.close()
    }

    void connect()
    return () => {
      disposed = true
      window.clearTimeout(catchupRetryRef.current?.timer)
      catchupRetryRef.current = null
      window.clearTimeout(groupRetryRef.current)
      window.clearTimeout(reconnectTimer)
      window.clearTimeout(stableTimer)
      socketRef.current?.close()
      socketRef.current = null
    }
  }, [applyMessages, catchUp, onSessionRevoked, prefix, reconcilePending, refreshChats, session.token, session.user.id, subscribe, updatePending])

  useEffect(() => {
    const onFocus = () => {
      void refreshChats()
      if (selectedId) void catchUp(selectedId)
      void reconcilePending()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [catchUp, reconcilePending, refreshChats, selectedId])

  useEffect(() => {
    if (!pending.some((send) => send.status === 'sending' || send.status === 'retryable' || send.status === 'queued')) return
    let timer: number
    const poll = () => {
      void reconcilePending()
      timer = window.setTimeout(poll, (24 + Math.random() * 12) * 1000)
    }
    timer = window.setTimeout(poll, (24 + Math.random() * 12) * 1000)
    return () => window.clearTimeout(timer)
  }, [pending, reconcilePending])

  const selectChat = useCallback((chatId: string) => {
    readingHistoryRef.current.delete(chatId)
    setSelectedId(chatId)
    void catchUp(chatId, true)
  }, [catchUp])

  const setAtLatestPosition = useCallback((chatId: string, atLatest: boolean) => {
    if (atLatest) readingHistoryRef.current.delete(chatId)
    else readingHistoryRef.current.add(chatId)
  }, [])

  const sendMessage = useCallback((chatId: string, body: string) => {
    const trimmed = body.trim()
    if (!trimmed || trimmed.length > 4000) return false
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      setError('Reconnecting. Your message has not been sent yet.')
      return false
    }
    if (pendingRef.current.filter((send) => send.status === 'sending' || send.status === 'retryable' || send.status === 'queued').length >= MAX_UNRESOLVED_SENDS) {
      setError('Too many messages are waiting for a result. Try again after some are resolved.')
      return false
    }
    const recipientId = chatId.startsWith('draft:') ? chatId.slice(6) : undefined
    const send: PendingSend = {
      chatId, recipientId, requestId: createUlid(), body: trimmed, createdAt: new Date().toISOString(), status: 'sending',
    }
    const next = retainPending([...pendingRef.current, send])
    pendingRef.current = next
    setPending(next)
    writeStored(`${prefix}.pending`, next)
    socketRef.current.send(JSON.stringify({ type: 'send', version: 1, ...(recipientId ? { recipientId } : { chatId }), requestId: send.requestId, body: trimmed }))
    setError(null)
    return true
  }, [prefix])

  const retryMessage = useCallback(async (requestId: string) => {
    const send = pendingRef.current.find((item) => item.requestId === requestId)
    if (!send || send.status !== 'retryable' || socketRef.current?.readyState !== WebSocket.OPEN) return
    try {
      const result = await api.sendStatus(session.token, send.requestId)
      if (result.status === 'saved') {
        if (!result.messageId || !result.chatId) throw new Error('Saved status is missing message details')
        updatePending(requestId, 'saved', { messageId: result.messageId, chatId: result.chatId })
        if (send.recipientId) {
          setSelectedId((current) => current === send.chatId ? result.chatId! : current)
          setDraftChat(undefined)
          await refreshChats()
        }
        await catchUp(result.chatId)
      } else if (result.status === 'rejected') {
        updatePending(requestId, 'rejected', { reason: result.reason || 'The message could not be saved.' })
      } else {
        updatePending(requestId, 'sending', { reason: undefined })
        socketRef.current.send(JSON.stringify({ type: 'send', version: 1, ...(send.recipientId ? { recipientId: send.recipientId } : { chatId: send.chatId }), requestId, body: send.body }))
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not check send status')
    }
  }, [catchUp, refreshChats, session.token, updatePending])

  const createDirect = useCallback(async (user: User) => {
    const existing = chatsRef.current.find((chat) => chat.kind === 'direct' && chat.members.some((member) => member.id === user.id))
    if (existing) {
      setDraftChat(undefined)
      selectChat(existing.id)
      return existing
    }
    const draft: Chat = {
      id: `draft:${user.id}`,
      kind: 'direct',
      name: null,
      members: [session.user, user],
      memberCount: 2,
      lastSequence: '0',
    }
    setDraftChat(draft)
    setSelectedId(draft.id)
    return draft
  }, [selectChat, session.user])

  const createGroup = useCallback(async (name: string, memberIds: string[]) => {
    const created = await api.createGroup(session.token, name, memberIds)
    await refreshChats()
    selectChat(created.id)
    return created
  }, [refreshChats, selectChat, session.token])

  return {
    chats, draftChat: draftChat?.id === selectedId ? draftChat : undefined, messages, pending, connection, selectedId, error, loading,
    hasMoreChats: nextChatCursor !== null, loadingMoreChats,
    loadingOlder: loadingOlder === selectedId,
    loadingNewer: loadingNewer === selectedId,
    jumpRevision,
    hasOlderMessages: Boolean(selectedId && messages[selectedId]?.length && BigInt(messages[selectedId][0].sequence) > 1n),
    hasNewerMessages: Boolean(selectedId && hasMoreNewer(messages[selectedId] || [], latestSequences[selectedId] || '0')),
    hasUnresolvedGap: Boolean(selectedId && hasUnresolvedGap(messages[selectedId] || [], cursorRef.current[selectedId] || '0')),
    selectChat, setAtLatestPosition, sendMessage, retryMessage, createDirect, createGroup, refreshChats, loadMoreChats, loadOlder, loadNewer, showLatest, clearError: () => setError(null),
  }
}
