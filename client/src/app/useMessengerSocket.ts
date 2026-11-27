import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { Chat } from '../entities/chat/model'
import type { ChatRecovery } from '../entities/message/chatRecovery'
import type { Message } from '../entities/message/model'
import type { SavedSend, SendRequests } from '../entities/message/sendRequests'
import { EventType } from '../shared/api/generated/socket-vocabulary'
import type { api } from '../shared/api/http'
import type { ActivityMessage, SocketEvent } from '../shared/api/socket'
import { connectSocket, type ConnectionState } from '../shared/api/socketConnection'
import { runtimeConfig } from '../shared/config/runtime'
import { reconnectDelay } from '../shared/lib/reconnect'

interface MessengerSocketOptions {
  onFeatureEvent(event: SocketEvent): boolean
  onPresenceEvent(event: SocketEvent): boolean
  sessionApi: ReturnType<typeof api.forSession>
  userId: string
  recovery: ChatRecovery
  requests: SendRequests
  socketRef: MutableRefObject<WebSocket | null>
  socketGenerationRef: MutableRefObject<number>
  focusFreshAtRef: MutableRefObject<number>
  focusRequestRef: MutableRefObject<Promise<void> | null>
  selectedRef: MutableRefObject<string | null>
  setConnectionGeneration: Dispatch<SetStateAction<number>>
  setNextRetryAt: Dispatch<SetStateAction<number | null>>
  retryNowRef: MutableRefObject<() => void>
  setConnection: Dispatch<SetStateAction<ConnectionState>>
  onSessionRevoked(): void
  reconcilePending(retryUnknown?: boolean): Promise<void>
  refreshChats(full?: boolean, invalidated?: boolean): Promise<Chat[]>
  listChats(): Chat[]
  refreshChatSummary(chatId: string): Promise<void>
  applyActivity(chatId: string, sequence: string, message: ActivityMessage): boolean
  catchUp(chatId: string, fromStart?: boolean, fresh?: boolean): Promise<void>
  selectResolvedDraft(saved: SavedSend): boolean
  removeChat(chatId: string): Chat[]
  closeChat(): void
  setMessages: Dispatch<SetStateAction<Record<string, Message[]>>>
  setLatestSequences: Dispatch<SetStateAction<Record<string, string>>>
  leaveHistory(chatId: string): void
}

const PREVIEW_LENGTH = 160

/**
 * The chat-list view of a new message. Group activity carries it; a saved direct or selected-chat message
 * has everything except the sender's name, which the row's members provide when known.
 */
function activityMessage(
  frame: Extract<SocketEvent, { type: 'sidebar_activity' | typeof EventType.MESSAGE_SAVED }>,
  chats: Chat[],
): ActivityMessage | null {
  if (frame.type === 'sidebar_activity') {
    const { messageId, senderId, senderUsername, createdAt, preview } = frame
    return messageId && senderId && senderUsername && createdAt && preview
      ? { messageId, senderId, senderUsername, createdAt, preview }
      : null
  }
  const sender = chats
    .find((chat) => chat.id === frame.chatId)
    ?.members.find((member) => member.id === frame.senderId)
  if (!sender) return null
  return {
    messageId: frame.messageId,
    senderId: frame.senderId,
    senderUsername: sender.username,
    createdAt: frame.createdAt,
    preview: [...frame.body].slice(0, PREVIEW_LENGTH).join(''),
  }
}

function websocketUrl(): string {
  return runtimeConfig.wsUrl
}

function socketErrorMessage(code?: string): string {
  switch (code) {
    case 'UNAUTHORIZED':
      return 'You can no longer send to this chat.'
    case 'PUBLISH_UNKNOWN':
      return 'Queue confirmation was lost. Check status before retrying.'
    case 'DEPENDENCY_UNAVAILABLE':
      return 'The message service is unavailable. Try again.'
    case 'PUBLISH_FAILED':
      return 'The message could not be queued. Try again.'
    default:
      return 'Could not queue this message. Try again.'
  }
}

export function useMessengerSocket({
  onFeatureEvent,
  onPresenceEvent,
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
  setConnectionGeneration,
  retryNowRef,
  onSessionRevoked,
  reconcilePending,
  refreshChats,
  listChats,
  refreshChatSummary,
  applyActivity,
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
  const userSeqRef = useRef(0n)
  const createdChatRef = useRef<string | null>(null)

  useEffect(() => {
    let summary:
      | { phase: 'idle' | 'refreshing' | 'closed' }
      | {
          phase: 'scheduled'
          timer: ReturnType<typeof setTimeout>
        } = { phase: 'idle' }
    const disposed = () => summary.phase === 'closed'
    // Chats whose row needs a refresh, with the sequence the row must reach (null: refresh regardless).
    const summaryChats = new Map<string, string | null>()
    const refreshSummaries = async () => {
      if (disposed() || summary.phase === 'refreshing') return
      summary = { phase: 'refreshing' }
      const batch = [...summaryChats].slice(0, 10)
      for (const [id] of batch) summaryChats.delete(id)
      const rows = listChats()
      await Promise.all(
        batch.map(async ([id, sequence]) => {
          // Activity that arrived after this was queued may already have brought the row up to date.
          const row = rows.find((chat) => chat.id === id)
          if (sequence !== null && row && BigInt(row.lastSequence) >= BigInt(sequence)) return
          try {
            if (!disposed()) await refreshChatSummary(id)
          } catch {}
        }),
      )
      if (disposed()) return
      summary = summaryChats.size
        ? {
            phase: 'scheduled',
            timer: setTimeout(() => void refreshSummaries(), 500 + Math.random() * 1500),
          }
        : { phase: 'idle' }
    }
    const invalidateSummary = (id: string, jitter = false, sequence: string | null = null) => {
      if (disposed() || (summaryChats.size >= 100 && !summaryChats.has(id))) return
      const queued = summaryChats.get(id)
      // Keep the highest sequence to reach; any unconditional request makes the refresh unconditional.
      if (queued === undefined) summaryChats.set(id, sequence)
      else if (queued === null || sequence === null) summaryChats.set(id, null)
      else if (BigInt(sequence) > BigInt(queued)) summaryChats.set(id, sequence)
      if (summary.phase === 'idle')
        summary = {
          phase: 'scheduled',
          timer: setTimeout(
            () => void refreshSummaries(),
            500 + (jitter ? Math.random() * 1500 : 0),
          ),
        }
    }
    const close = connectSocket({
      url: websocketUrl(),
      ticket: (signal) => sessionApi.wsTicket(signal),
      onState: setConnection,
      onRetryScheduled: setNextRetryAt,
      onSessionRevoked,
      onOpen: (socket) => {
        setConnectionGeneration((value) => value + 1)
        socketGenerationRef.current += 1
        focusFreshAtRef.current = 0
        socketRef.current = socket
        recovery.onSocketOpened(selectedRef.current)
        void reconcilePending(true)
      },
      onEvent: (frame, socket) => {
        if ('userSeq' in frame && typeof frame.userSeq === 'string') {
          const userSeq = BigInt(frame.userSeq)
          if (userSeqRef.current > 0n && userSeq > userSeqRef.current + 1n)
            void refreshChats(true, true)
          if (userSeq > userSeqRef.current) userSeqRef.current = userSeq
        }
        if (frame.type === EventType.MESSAGE_SAVED || frame.type === 'sidebar_activity') {
          const message = activityMessage(frame, listChats())
          if (!message || !applyActivity(frame.chatId, frame.sequence, message))
            invalidateSummary(frame.chatId, frame.type === 'sidebar_activity', frame.sequence)
        } else if (
          frame.type === 'message_changed' ||
          frame.type === 'history_changed' ||
          // Only my own reads change my unread count; only those carry my member sequence.
          (frame.type === 'reads_changed' && frame.memberSeq !== undefined)
        )
          invalidateSummary(frame.chatId)
        if (frame.type === 'history_changed') void refreshChats(false, true)
        if (frame.type === 'message_changed') requests.revised(frame.messageId)
        if (frame.type === 'chat_preferences_changed') {
          if (listChats().some((chat) => chat.id === frame.chatId)) invalidateSummary(frame.chatId)
          else void refreshChats(false, true)
          onFeatureEvent(frame)
          return
        }
        if (onPresenceEvent(frame) || onFeatureEvent(frame)) return
        if (frame.type === EventType.SUBSCRIBED && frame.chatId === selectedRef.current) {
          window.clearTimeout(groupRetryRef.current)
          groupRetryRef.current = undefined
          groupRetryAttemptsRef.current = 0
        } else if (frame.type === EventType.CHAT_CREATED) {
          if (frame.chatId === selectedRef.current) createdChatRef.current = frame.chatId
          void refreshChats(false, true).then((list) => {
            if (disposed() || socketRef.current !== socket) return
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
              if (disposed() || socketRef.current !== socket) return
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
              forwardedFromUserId: frame.forwardedFromUserId,
            },
            frame.room,
            () =>
              !disposed() && socketRef.current === socket && socket.readyState === WebSocket.OPEN,
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
          if (
            ['RATE_LIMITED', 'ROOM_LIMIT', 'DEPENDENCY_UNAVAILABLE', 'PUBLISH_FAILED'].includes(
              frame.code ?? '',
            )
          )
            requests.transient(frame.requestId)
          else if (frame.code === 'PUBLISH_UNKNOWN') requests.unknown(frame.requestId)
          else requests.retryable(frame.requestId, socketErrorMessage(frame.code))
        } else if (
          frame.type === EventType.ERROR &&
          !frame.requestId &&
          frame.code === 'UNAUTHORIZED'
        ) {
          void refreshChats(false, true)
        } else if (
          frame.type === EventType.ERROR &&
          !frame.requestId &&
          frame.code === 'DEPENDENCY_UNAVAILABLE'
        ) {
          if (groupRetryRef.current === undefined) {
            groupRetryRef.current = window.setTimeout(() => {
              groupRetryRef.current = undefined
              const active = selectedRef.current
              if (active) recovery.renewGroup(active)
            }, reconnectDelay(++groupRetryAttemptsRef.current))
          }
        } else if (frame.type === EventType.RECOVERY_FAILED) {
          // The missing message may be newer than a catch-up already in flight, so read again after it.
          void catchUp(frame.chatId, false, true)
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
        requests.disconnected()
        socketRef.current = null
        recovery.onSocketClosed()
        window.clearTimeout(groupRetryRef.current)
        groupRetryRef.current = undefined
      },
    })
    retryNowRef.current = close.retryNow
    return () => {
      retryNowRef.current = () => {}
      if (summary.phase === 'scheduled') clearTimeout(summary.timer)
      summary = { phase: 'closed' }
      summaryChats.clear()
      close()
    }
  }, [
    onFeatureEvent,
    onPresenceEvent,
    setNextRetryAt,
    setConnectionGeneration,
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
