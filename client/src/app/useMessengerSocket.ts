import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { Chat } from '../entities/chat/model'
import type { ChatRecovery } from '../entities/message/chatRecovery'
import type { Message } from '../entities/message/model'
import type { SavedSend, SendRequests } from '../entities/message/sendRequests'
import { EventType } from '../shared/api/generated/socket-vocabulary'
import type { api } from '../shared/api/http'
import type { SocketEvent } from '../shared/api/socket'
import { connectSocket, type ConnectionState } from '../shared/api/socketConnection'
import { reconnectDelay } from '../shared/lib/reconnect'

interface MessengerSocketOptions {
  onFeatureEvent(event: SocketEvent): boolean
  sessionApi: ReturnType<typeof api.forSession>
  userId: string
  recovery: ChatRecovery
  requests: SendRequests
  socketRef: MutableRefObject<WebSocket | null>
  socketGenerationRef: MutableRefObject<number>
  focusFreshAtRef: MutableRefObject<number>
  focusRequestRef: MutableRefObject<Promise<void> | null>
  selectedRef: MutableRefObject<string | null>
  setNextRetryAt: Dispatch<SetStateAction<number | null>>
  retryNowRef: MutableRefObject<() => void>
  setConnection: Dispatch<SetStateAction<ConnectionState>>
  onSessionRevoked(): void
  reconcilePending(retryUnknown?: boolean): Promise<void>
  refreshChats(full?: boolean, invalidated?: boolean): Promise<Chat[]>
  listChats(): Chat[]
  refreshChatSummary(chatId: string): Promise<void>
  catchUp(chatId: string, fromStart?: boolean): Promise<void>
  selectResolvedDraft(saved: SavedSend): boolean
  removeChat(chatId: string): Chat[]
  closeChat(): void
  setMessages: Dispatch<SetStateAction<Record<string, Message[]>>>
  setLatestSequences: Dispatch<SetStateAction<Record<string, string>>>
  leaveHistory(chatId: string): void
}

function websocketUrl(): string {
  return import.meta.env.VITE_WS_URL || 'ws://localhost:8082/ws'
}

function socketErrorMessage(code?: string): string {
  switch (code) {
    case 'rate_limited':
      return 'Sending too quickly. Wait a moment and try again.'
    case 'unauthorized':
      return 'You can no longer send to this chat.'
    case 'room_limit':
      return 'Too many active chats. Try again shortly.'
    case 'publish_unknown':
      return 'Queue confirmation was lost. Check status before retrying.'
    case 'dependency_unavailable':
      return 'The message service is unavailable. Try again.'
    case 'publish_failed':
      return 'The message could not be queued. Try again.'
    default:
      return 'Could not queue this message. Try again.'
  }
}

export function useMessengerSocket({
  onFeatureEvent,
  sessionApi,
  userId,
  recovery,
  requests,
  socketRef,
  socketGenerationRef,
  focusFreshAtRef,
  focusRequestRef,
  selectedRef,
  setConnection,
  setNextRetryAt,
  retryNowRef,
  onSessionRevoked,
  reconcilePending,
  refreshChats,
  listChats,
  refreshChatSummary,
  catchUp,
  selectResolvedDraft,
  removeChat,
  closeChat,
  setMessages,
  setLatestSequences,
  leaveHistory,
}: MessengerSocketOptions) {
  const groupRetryRef = useRef<number | undefined>(undefined)
  const groupRetryAttemptsRef = useRef(0)
  const createdChatRef = useRef<string | null>(null)

  useEffect(() => {
    let disposed = false
    const summaryChats = new Set<string>()
    let summaryTimer: ReturnType<typeof setTimeout> | undefined
    let summaryRunning = false
    const refreshSummaries = async () => {
      summaryTimer = undefined
      if (disposed || summaryRunning) return
      summaryRunning = true
      const batch = [...summaryChats].slice(0, 10)
      for (const id of batch) summaryChats.delete(id)
      await Promise.all(
        batch.map(async (id) => {
          try {
            if (!disposed) await refreshChatSummary(id)
          } catch {}
        }),
      )
      summaryRunning = false
      if (!disposed && summaryChats.size)
        summaryTimer = setTimeout(() => void refreshSummaries(), 500)
    }
    const invalidateSummary = (id: string) => {
      if (summaryChats.size >= 100 && !summaryChats.has(id)) return
      summaryChats.add(id)
      if (summaryTimer === undefined && !summaryRunning)
        summaryTimer = setTimeout(() => void refreshSummaries(), 500)
    }
    const close = connectSocket({
      url: websocketUrl(),
      ticket: () => sessionApi.wsTicket(),
      onState: setConnection,
      onRetryScheduled: setNextRetryAt,
      onSessionRevoked,
      onOpen: (socket) => {
        socketGenerationRef.current += 1
        focusFreshAtRef.current = 0
        socketRef.current = socket
        recovery.onSocketOpened(selectedRef.current)
        void reconcilePending(true)
      },
      onEvent: (frame, socket) => {
        if (
          frame.type === EventType.MESSAGE_SAVED ||
          frame.type === 'message_changed' ||
          frame.type === 'history_changed' ||
          frame.type === 'reads_changed'
        )
          invalidateSummary(frame.chatId)
        if (frame.type === 'history_changed') void refreshChats(false, true)
        if (frame.type === 'message_changed') requests.revised(frame.messageId)
        if (onFeatureEvent(frame)) return
        if (frame.type === EventType.SUBSCRIBED && frame.chatId === selectedRef.current) {
          window.clearTimeout(groupRetryRef.current)
          groupRetryRef.current = undefined
          groupRetryAttemptsRef.current = 0
        } else if (frame.type === EventType.CHAT_CREATED) {
          if (frame.chatId === selectedRef.current) createdChatRef.current = frame.chatId
          void refreshChats(false, true).then((list) => {
            if (disposed || socketRef.current !== socket) return
            const created = createdChatRef.current
            createdChatRef.current = null
            if (created && list.some((chat) => chat.id === created)) {
              recovery.onChatCreated(created)
            }
          })
        } else if (frame.type === EventType.MEMBERSHIP_CHANGED) {
          void refreshChats(false, true)
        } else if (frame.type === EventType.QUEUED) {
          requests.queued(frame.requestId)
        } else if (frame.type === EventType.MESSAGE_SAVED) {
          if (!listChats().some((item) => item.id === frame.chatId)) {
            if (
              frame.chatId === selectedRef.current ||
              requests.list().some((send) => send.requestId === frame.requestId)
            )
              createdChatRef.current = frame.chatId
            void refreshChats(false, true).then((list) => {
              if (disposed || socketRef.current !== socket) return
              const created = createdChatRef.current
              createdChatRef.current = null
              if (created && list.some((chat) => chat.id === created))
                recovery.onChatCreated(created)
            })
          }
          void recovery.onLive(
            {
              id: frame.messageId,
              chatId: frame.chatId,
              sequence: frame.sequence,
              senderId: frame.senderId,
              body: frame.body,
              createdAt: frame.createdAt,
              messageVersion: frame.messageVersion,
              replyToMessageId: frame.replyToMessageId,
              replySenderId: frame.replySenderId,
              replyBody: frame.replyBody,
              replyDeleted: frame.replyDeleted,
              replyVersion: frame.replyVersion,
            },
            frame.room,
            () => !disposed && socketRef.current === socket && socket.readyState === WebSocket.OPEN,
            frame.epoch,
            frame.streamId,
          )
          if (frame.requestId) {
            const saved = requests.saved(
              frame.requestId,
              frame.chatId,
              frame.messageId,
              frame.sequence,
            )
            if (saved) selectResolvedDraft(saved)
            if (!recovery.acceptsSaved(frame.chatId, frame.messageId, frame.sequence))
              requests.revised(frame.messageId)
          }
        } else if (frame.type === EventType.SEND_REJECTED) {
          requests.rejected(frame.requestId, frame.reason)
        } else if (frame.type === EventType.ERROR && frame.requestId) {
          requests.retryable(frame.requestId, socketErrorMessage(frame.code))
        } else if (
          frame.type === EventType.ERROR &&
          !frame.requestId &&
          frame.code === 'unauthorized'
        ) {
          void refreshChats(false, true)
        } else if (
          frame.type === EventType.ERROR &&
          !frame.requestId &&
          frame.code === 'dependency_unavailable'
        ) {
          if (groupRetryRef.current === undefined) {
            groupRetryRef.current = window.setTimeout(() => {
              groupRetryRef.current = undefined
              const active = selectedRef.current
              if (active) recovery.renewGroup(active)
            }, reconnectDelay(++groupRetryAttemptsRef.current))
          }
        } else if (frame.type === EventType.RECOVERY_FAILED) {
          void catchUp(frame.chatId)
          void reconcilePending()
        } else if (frame.type === EventType.SUBSCRIPTION_EXPIRED) {
          recovery.onSubscriptionExpired(frame.chatId)
        } else if (frame.type === EventType.MEMBER_REMOVED) {
          if (frame.memberId !== userId) {
            void refreshChats(false, true)
            return
          }
          const removedId = frame.chatId
          removeChat(removedId)
          if (selectedRef.current === removedId) closeChat()
          requests.forget(removedId)
          recovery.forget(removedId)
          setMessages(recovery.visibleWindows())
          setLatestSequences(recovery.latestSequences())
          leaveHistory(removedId)
          void refreshChats(false, true)
        }
      },
      onClose: () => {
        socketGenerationRef.current += 1
        focusFreshAtRef.current = 0
        focusRequestRef.current = null
        createdChatRef.current = null
        socketRef.current = null
        recovery.onSocketClosed()
        window.clearTimeout(groupRetryRef.current)
        groupRetryRef.current = undefined
      },
    })
    retryNowRef.current = close.retryNow
    return () => {
      retryNowRef.current = () => {}
      disposed = true
      clearTimeout(summaryTimer)
      summaryChats.clear()
      close()
    }
  }, [
    onFeatureEvent,
    setNextRetryAt,
    retryNowRef,
    catchUp,
    onSessionRevoked,
    recovery,
    reconcilePending,
    refreshChats,
    requests,
    selectResolvedDraft,
    sessionApi,
    userId,
    listChats,
    refreshChatSummary,
    removeChat,
    leaveHistory,
    closeChat,
  ])
}
