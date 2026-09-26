import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Conversation } from '../entities/conversation/model'
import { advanceSend, mergeMessages, type Message, type PendingSend, type SendState } from '../entities/message/model'
import type { Session } from '../entities/session/model'
import { api } from '../shared/api/http'
import { createUlid } from '../shared/lib/id'

type Connection = 'connecting' | 'connected' | 'offline'
type MessageMap = Record<string, Message[]>
type CursorMap = Record<string, string>
type RoomCursor = { epoch: string; streamId: string }
type RoomCursorMap = Record<string, RoomCursor>

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

function websocketUrl(token: string): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${location.host}/ws?token=${encodeURIComponent(token)}`
}

interface SocketFrame {
  type?: string
  event?: SocketFrame
  payload?: SocketFrame
  conversationId?: string
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
    case 'unauthorized': return 'You can no longer send to this conversation.'
    case 'room_limit': return 'Too many active conversations. Try again shortly.'
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

export function useMessenger(session: Session) {
  const prefix = `relay.${session.user.id}.${session.deviceId}`
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [messages, setMessages] = useState<MessageMap>(() => readStored(`${prefix}.messages`, {}))
  const [pending, setPending] = useState<PendingSend[]>(() => readStored(`${prefix}.pending`, []))
  const [connection, setConnection] = useState<Connection>('connecting')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const socketRef = useRef<WebSocket | null>(null)
  const conversationsRef = useRef(conversations)
  const messagesRef = useRef(messages)
  const pendingRef = useRef(pending)
  const cursorRef = useRef<CursorMap>(readStored(`${prefix}.cursor`, {}))
  const roomCursorRef = useRef<RoomCursorMap>(readStored(`${prefix}.room-cursor`, {}))
  const catchupRef = useRef(new Set<string>())

  const updatePending = useCallback((requestId: string, status: SendState, extra: Partial<PendingSend> = {}) => {
    const next = pendingRef.current.map((send) => send.requestId === requestId ? advanceSend(send, status, extra) : send)
    pendingRef.current = next
    setPending(next)
    writeStored(`${prefix}.pending`, next)
  }, [prefix])

  const applyMessages = useCallback((conversationId: string, incoming: Message[]) => {
    if (!incoming.length) return
    const merged = mergeMessages(messagesRef.current[conversationId] || [], incoming)
    messagesRef.current = { ...messagesRef.current, [conversationId]: merged }
    setMessages(messagesRef.current)
    writeStored(`${prefix}.messages`, messagesRef.current)

    const sequences = new Set(merged.map((message) => message.sequence))
    let cursor = BigInt(cursorRef.current[conversationId] || '0')
    while (sequences.has((cursor + 1n).toString())) cursor += 1n
    if (cursor.toString() !== cursorRef.current[conversationId]) {
      cursorRef.current = { ...cursorRef.current, [conversationId]: cursor.toString() }
      writeStored(`${prefix}.cursor`, cursorRef.current)
    }
  }, [prefix])

  const catchUp = useCallback(async (conversationId: string, fromStart = false) => {
    if (catchupRef.current.has(conversationId)) return
    catchupRef.current.add(conversationId)
    try {
      let after = fromStart ? '0' : cursorRef.current[conversationId] || '0'
      for (let page = 0; page < 200; page += 1) {
        const result = await api.messages(session.token, conversationId, after)
        applyMessages(conversationId, result.messages)
        if (result.messages.length === 0 || result.nextSequence === after) break
        after = result.nextSequence
        if (result.messages.length < 50) break
      }
      const sequence = cursorRef.current[conversationId]
      if (sequence && socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: 'applied', version: 1, conversationId, sequence }))
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load conversation history')
    } finally {
      catchupRef.current.delete(conversationId)
    }
  }, [applyMessages, session.token])

  const refreshConversations = useCallback(async () => {
    try {
      const list = await api.conversations(session.token)
      conversationsRef.current = list
      setConversations(list)
      setSelectedId((current) => current && list.some((item) => item.id === current) ? current : list[0]?.id || null)
      setError(null)
      return list
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load conversations')
      return []
    } finally {
      setLoading(false)
    }
  }, [session.token])

  useEffect(() => {
    void refreshConversations().then((list) => list.forEach((item) => void catchUp(item.id, !(messagesRef.current[item.id]?.length))))
  }, [catchUp, refreshConversations])

  const reconcilePending = useCallback(async (retryUnknown = false) => {
    for (const send of pendingRef.current.filter((item) => item.status === 'sending' || item.status === 'retryable' || item.status === 'queued')) {
      try {
        const result = await api.sendStatus(session.token, send.conversationId, send.requestId)
        if (result.status === 'saved') {
          if (!result.messageId) throw new Error('Saved status is missing a message ID')
          updatePending(send.requestId, 'saved', { messageId: result.messageId })
          await catchUp(send.conversationId)
        } else if (result.status === 'rejected') {
          updatePending(send.requestId, 'rejected', { reason: result.reason || 'The message could not be saved.' })
        } else if (retryUnknown && (send.status === 'sending' || send.status === 'retryable') && socketRef.current?.readyState === WebSocket.OPEN) {
          updatePending(send.requestId, 'sending', { reason: undefined })
          socketRef.current.send(JSON.stringify({
            type: 'send', version: 1, conversationId: send.conversationId, requestId: send.requestId, body: send.body,
          }))
        }
      } catch { /* The next reconnect or status check will retry. */ }
    }
  }, [catchUp, session.token, updatePending])

  const subscribe = useCallback((conversationId: string) => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) return
    const conversation = conversationsRef.current.find((item) => item.id === conversationId)
    const room = conversation?.kind === 'group' ? `group:${conversationId}` : `user:${session.user.id}`
    const roomCursor = roomCursorRef.current[room]
    socketRef.current.send(JSON.stringify({
      type: 'subscribe', version: 1, conversationId,
      lastAppliedSequence: cursorRef.current[conversationId] || '0',
      ...(roomCursor || {}),
    }))
  }, [session.user.id])

  const conversationIds = useMemo(() => conversations.map((item) => item.id).sort().join(','), [conversations])

  useEffect(() => {
    let disposed = false
    let reconnectTimer: number | undefined
    let attempts = 0

    function connect() {
      if (disposed) return
      setConnection('connecting')
      const socket = new WebSocket(websocketUrl(session.token))
      socketRef.current = socket
      socket.onopen = () => {
        attempts = 0
        setConnection('connected')
        for (const conversationId of conversationIds.split(',').filter(Boolean)) {
          subscribe(conversationId)
          void catchUp(conversationId)
        }
        void reconcilePending(true)
      }
      socket.onmessage = (event: MessageEvent<string>) => {
        let frame: SocketFrame
        try { frame = unwrap(JSON.parse(event.data) as SocketFrame) } catch { return }
        const kind = frame.type?.toLowerCase()
        if (kind === 'queued' && frame.requestId) {
          updatePending(frame.requestId, 'queued')
        } else if ((kind === 'message_saved' || kind === 'saved' || kind === 'message') && frame.conversationId && frame.messageId && frame.sequence && frame.senderId && typeof frame.body === 'string') {
          if (!conversationsRef.current.some((item) => item.id === frame.conversationId)) void refreshConversations()
          const previous = BigInt(cursorRef.current[frame.conversationId] || '0')
          applyMessages(frame.conversationId, [{
            id: frame.messageId,
            conversationId: frame.conversationId,
            sequence: frame.sequence,
            senderId: frame.senderId,
            body: frame.body,
            createdAt: frame.createdAt || new Date().toISOString(),
          }])
          if (frame.requestId) updatePending(frame.requestId, 'saved', { messageId: frame.messageId })
          const acknowledge = async () => {
            if (BigInt(frame.sequence!) > previous + 1n) await catchUp(frame.conversationId!)
            if (BigInt(frame.sequence!) > BigInt(cursorRef.current[frame.conversationId!] || '0')) return
            const conversation = conversationsRef.current.find((item) => item.id === frame.conversationId)
            const room = frame.room || (conversation?.kind === 'group' ? `group:${frame.conversationId}` : `user:${session.user.id}`)
            if (frame.epoch && frame.streamId) {
              const previousRoom = roomCursorRef.current[room]
              if (!previousRoom || previousRoom.epoch !== frame.epoch || newerStreamId(frame.streamId, previousRoom.streamId)) {
                roomCursorRef.current = { ...roomCursorRef.current, [room]: { epoch: frame.epoch, streamId: frame.streamId } }
                writeStored(`${prefix}.room-cursor`, roomCursorRef.current)
              }
            }
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({
              type: 'applied', version: 1, conversationId: frame.conversationId,
              sequence: cursorRef.current[frame.conversationId!] || '0',
              ...(frame.epoch && frame.streamId ? { epoch: frame.epoch, streamId: frame.streamId } : {}),
            }))
          }
          void acknowledge()
        } else if ((kind === 'send_rejected' || kind === 'rejected') && frame.requestId) {
          updatePending(frame.requestId, 'rejected', { reason: frame.reason || 'The message could not be saved.' })
        } else if (kind === 'error' && frame.requestId) {
          updatePending(frame.requestId, 'retryable', { reason: frame.reason || socketErrorMessage(frame.code) })
        } else if (kind === 'recovery_failed' && frame.conversationId) {
          void catchUp(frame.conversationId)
        }
      }
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null
        if (disposed) return
        setConnection('offline')
        attempts += 1
        reconnectTimer = window.setTimeout(connect, Math.min(1000 * 2 ** attempts, 15000))
      }
      socket.onerror = () => socket.close()
    }

    connect()
    return () => {
      disposed = true
      window.clearTimeout(reconnectTimer)
      socketRef.current?.close()
      socketRef.current = null
    }
  }, [applyMessages, catchUp, conversationIds, prefix, reconcilePending, refreshConversations, session.token, session.user.id, subscribe, updatePending])

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshConversations()
      if (selectedId) void catchUp(selectedId)
      void reconcilePending()
    }, 30000)
    const onFocus = () => {
      if (selectedId) void catchUp(selectedId)
      void reconcilePending()
    }
    window.addEventListener('focus', onFocus)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', onFocus) }
  }, [catchUp, reconcilePending, refreshConversations, selectedId])

  const selectConversation = useCallback((conversationId: string) => {
    setSelectedId(conversationId)
    subscribe(conversationId)
    void catchUp(conversationId, !(messagesRef.current[conversationId]?.length))
  }, [catchUp, subscribe])

  const sendMessage = useCallback((conversationId: string, body: string) => {
    const trimmed = body.trim()
    if (!trimmed || trimmed.length > 4000) return false
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      setError('Reconnecting. Your message has not been sent yet.')
      return false
    }
    const send: PendingSend = {
      conversationId, requestId: createUlid(), body: trimmed, createdAt: new Date().toISOString(), status: 'sending',
    }
    const next = [...pendingRef.current, send]
    pendingRef.current = next
    setPending(next)
    writeStored(`${prefix}.pending`, next)
    socketRef.current.send(JSON.stringify({ type: 'send', version: 1, conversationId, requestId: send.requestId, body: trimmed }))
    setError(null)
    return true
  }, [prefix])

  const retryMessage = useCallback(async (requestId: string) => {
    const send = pendingRef.current.find((item) => item.requestId === requestId)
    if (!send || send.status !== 'retryable' || socketRef.current?.readyState !== WebSocket.OPEN) return
    try {
      const result = await api.sendStatus(session.token, send.conversationId, send.requestId)
      if (result.status === 'saved') {
        if (!result.messageId) throw new Error('Saved status is missing a message ID')
        updatePending(requestId, 'saved', { messageId: result.messageId })
        await catchUp(send.conversationId)
      } else if (result.status === 'rejected') {
        updatePending(requestId, 'rejected', { reason: result.reason || 'The message could not be saved.' })
      } else {
        updatePending(requestId, 'sending', { reason: undefined })
        socketRef.current.send(JSON.stringify({ type: 'send', version: 1, conversationId: send.conversationId, requestId, body: send.body }))
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not check send status')
    }
  }, [catchUp, session.token, updatePending])

  const createDirect = useCallback(async (userId: string) => {
    const created = await api.createDirect(session.token, userId)
    await refreshConversations()
    selectConversation(created.id)
    return created
  }, [refreshConversations, selectConversation, session.token])

  const createGroup = useCallback(async (name: string, memberIds: string[]) => {
    const created = await api.createGroup(session.token, name, memberIds)
    await refreshConversations()
    selectConversation(created.id)
    return created
  }, [refreshConversations, selectConversation, session.token])

  return {
    conversations, messages, pending, connection, selectedId, error, loading,
    selectConversation, sendMessage, retryMessage, createDirect, createGroup, refreshConversations, clearError: () => setError(null),
  }
}
