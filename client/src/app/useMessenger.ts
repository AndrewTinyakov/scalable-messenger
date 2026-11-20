import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Chat, ChatPreferences } from '../entities/chat/model'
import { ChatRecovery } from '../entities/message/chatRecovery'
import { HISTORY_PAGE_SIZE, historyAvailability } from '../entities/message/historyWindow'
import type { Message, PendingSend } from '../entities/message/model'
import type { ReadingLocation } from '../entities/message/readingLocation'
import type { SendRequests } from '../entities/message/sendRequests'
import type { Session } from '../entities/session/model'
import { useConversationFeatures } from '../features/conversation/useConversationFeatures'
import { useMessagePins } from '../features/message-pins/useMessagePins'
import { ChatKind } from '../shared/api/generated/socket-vocabulary'
import { api } from '../shared/api/http'
import {
  groupRoom,
  sendSocketFrame,
  userRoom,
  type OutgoingSocketFrame,
} from '../shared/api/socket'
import type { ConnectionState } from '../shared/api/socketConnection'
import { WatchPacer } from '../shared/api/watchPacer'
import { isNetworkOnline } from '../shared/lib/network'
import { createMessengerSendRequests } from './messengerSendRequests'
import { useChatDirectory } from './useChatDirectory'
import { useChatHistory } from './useChatHistory'
import { useChatLocation } from './useChatLocation'
import { useChatNavigation } from './useChatNavigation'
import { useMessengerFocus } from './useMessengerFocus'
import { useMessengerSends } from './useMessengerSends'
import { useMessengerSocket } from './useMessengerSocket'
import { useRecoveryLifecycle } from './useRecoveryLifecycle'
import { useSidebarWatch } from './useSidebarWatch'

export function useMessenger(session: Session, onSessionRevoked: () => void) {
  const location = useChatLocation()
  const { navigate } = location
  const prefix = `relay.${session.user.id}.${session.deviceId}`
  const recoveryRef = useRef<{ prefix: string; value: ChatRecovery } | null>(null)
  if (recoveryRef.current?.prefix !== prefix)
    recoveryRef.current = { prefix, value: new ChatRecovery(prefix) }
  const recovery = recoveryRef.current.value
  const [messages, setMessages] = useState<Record<string, Message[]>>({})
  const [latestSequences, setLatestSequences] = useState<Record<string, string>>({})
  const [jumpRevision, setJumpRevision] = useState(0)
  const [locationRevision, setLocationRevision] = useState(0)
  const [pending, setPending] = useState<PendingSend[]>([])
  const [connectionGeneration, setConnectionGeneration] = useState(0)
  const [nextRetryAt, setNextRetryAt] = useState<number | null>(null)
  const retryNowRef = useRef<() => void>(() => {})
  const retryNow = useCallback(() => retryNowRef.current(), [])
  const [connection, setConnection] = useState<ConnectionState>('connecting')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draftChat, setDraftChat] = useState<Chat | undefined>()
  const [error, setErrorState] = useState<string | null>(null)
  const setError = useCallback((message: string | null) => {
    if (!message || isNetworkOnline()) setErrorState(message)
  }, [])
  const socketRef = useRef<WebSocket | null>(null)
  const sessionApi = useMemo(() => api.forSession(session), [session.user.id, session.deviceId])
  const requestsRef = useRef<{ prefix: string; value: SendRequests } | null>(null)
  if (requestsRef.current?.prefix !== prefix) {
    requestsRef.current = {
      prefix,
      value: createMessengerSendRequests(prefix, sessionApi, socketRef, setPending),
    }
  }
  const requests = requestsRef.current.value
  const activeRef = useRef(true)
  const socketGenerationRef = useRef(0)
  const focusRequestRef = useRef<Promise<void> | null>(null)
  const focusFreshAtRef = useRef(0)
  const recoveryFailureRef = useRef(0)
  const selectedRef = useRef<string | null>(null)
  const closeChat = useCallback(() => {
    setSelectedId(null)
    setDraftChat(undefined)
    navigate('/')
  }, [navigate])

  useEffect(() => {
    try {
      localStorage.removeItem(`${prefix}.messages`)
    } catch {
      /* Storage may be disabled. */
    }
    setPending(requests.list())
  }, [prefix, requests])

  const {
    loadingOlder,
    loadingNewer,
    showLatest,
    loadOlder,
    loadNewer,
    setAtLatestPosition,
    isReadingHistory,
    leaveHistory,
  } = useChatHistory(recovery, setError)

  const watchPacer = useMemo(
    () =>
      new WatchPacer((frame) => {
        const socket = socketRef.current
        if (socket?.readyState !== WebSocket.OPEN) return
        try {
          sendSocketFrame(socket, frame)
        } catch {
          socket.close()
        }
      }),
    [],
  )

  useEffect(() => () => watchPacer.reset(), [watchPacer, connectionGeneration])

  const sendConnectedFrame = useCallback(
    (frame: OutgoingSocketFrame | null) => {
      const socket = socketRef.current
      if (!frame || socket?.readyState !== WebSocket.OPEN) return
      if (['watch_presence', 'watch_sidebar', 'unwatch_presence'].includes(frame.type)) {
        watchPacer.offer(frame)
        return
      }
      try {
        sendSocketFrame(socket, frame)
      } catch {
        socket.close()
      }
    },
    [watchPacer],
  )

  const recordLatest = useCallback(
    (chatId: string, sequence: string) => {
      if (recovery.recordLatest(chatId, sequence)) setLatestSequences(recovery.latestSequences())
    },
    [recovery],
  )

  const selectAfterRefresh = useCallback((chats: Chat[]) => {
    setSelectedId((current) => {
      if (current?.startsWith('draft:')) {
        const recipientId = current.slice(6)
        return (
          chats.find(
            (chat) =>
              chat.kind === ChatKind.DIRECT &&
              chat.members.some((member) => member.id === recipientId),
          )?.id || current
        )
      }
      return current && chats.some((chat) => chat.id === current) ? current : null
    })
  }, [])

  const {
    chats,
    loading,
    loadingMoreChats,
    hasMoreChats,
    refreshChats,
    loadMoreChats,
    listChats,
    rememberChat,
    refreshChatSummary,
    applyActivity,
    applyPreferences,
    applyPinnedOrder,
    markRead,
    settleRead,
    isRemoved,
    successfulRefreshes,
    removeChat,
  } = useChatDirectory({
    sessionApi,
    userId: session.user.id,
    selectedId,
    selectedIdRef: selectedRef,
    recordLatest,
    onRefreshed: selectAfterRefresh,
    setError,
  })

  const roomForChat = useCallback(
    (chatId: string) => {
      const chat = listChats().find((item) => item.id === chatId)
      return chat?.kind === ChatKind.GROUP ? groupRoom(chatId) : userRoom(session.user.id)
    },
    [listChats, session.user.id],
  )

  const removeConversation = useCallback(
    (chatId: string) => {
      const removed = listChats().find((chat) => chat.id === chatId)
      const recipient =
        removed?.kind === ChatKind.DIRECT
          ? removed.members.find((member) => member.id !== session.user.id)?.id
          : undefined
      removeChat(chatId)
      requests.forget(chatId, recipient)
      recovery.forget(chatId)
      leaveHistory(chatId)
      setMessages(recovery.visibleWindows())
      setLatestSequences(recovery.latestSequences())
      if (selectedRef.current === chatId) closeChat()
    },
    [removeChat, requests, recovery, leaveHistory, closeChat, listChats, session.user.id],
  )
  const hideConversation = useCallback(
    (chatId: string) => {
      removeChat(chatId)
      leaveHistory(chatId)
      if (selectedRef.current === chatId) closeChat()
    },
    [removeChat, leaveHistory, closeChat],
  )
  const sidebar = useSidebarWatch({
    connectionGeneration,
    connected: connection === 'connected',
    userId: session.user.id,
    listChats,
    send: sendConnectedFrame,
  })
  const features = useConversationFeatures({
    chat:
      chats.find((chat) => chat.id === selectedId) ??
      (draftChat?.id === selectedId ? draftChat : undefined),
    connected: connection === 'connected',
    recovery,
    sessionApi,
    send: sendConnectedFrame,
    remove: removeConversation,
    hide: hideConversation,
    refreshChats,
    onReadPending: markRead,
    onReadCommitted: settleRead,
    onReadFailed: settleRead,
    fail: setError,
  })
  const pins = useMessagePins(
    selectedId && !selectedId.startsWith('draft:') ? selectedId : undefined,
    sessionApi,
    connection === 'connected',
    features.pinsState,
  )
  const pinsEventRef = useRef(pins.onEvent)
  pinsEventRef.current = pins.onEvent
  const featuresEventRef = useRef(features.onEvent)
  featuresEventRef.current = features.onEvent
  const onFeatureEvent = useCallback((event: Parameters<typeof features.onEvent>[0]) => {
    const handledByPins = pinsEventRef.current(event)
    return featuresEventRef.current(event) || handledByPins
  }, [])
  const withSnapshot = async (
    chatId: string,
    request: ReturnType<typeof sessionApi.latestMessages>,
  ) => {
    const result = await request
    features.snapshot(chatId, result.mutationSeq ?? '0')
    return result
  }

  recovery.configure({
    history: {
      latest: (chatId) => withSnapshot(chatId, sessionApi.latestMessages(chatId)),
      after: (chatId, sequence) =>
        withSnapshot(chatId, sessionApi.messages(chatId, sequence, HISTORY_PAGE_SIZE)),
      older: (chatId, sequence) =>
        withSnapshot(chatId, sessionApi.olderMessages(chatId, sequence, HISTORY_PAGE_SIZE)),
      around: (chatId, messageId, sequence) =>
        sessionApi.aroundMessage(chatId, messageId, sequence),
      visibility: async (chatId) => {
        const freshness = features.freshness(chatId)
        const state = await sessionApi.chatState(chatId, freshness)
        features.observeState(chatId, state, freshness === undefined)
        return {
          snapshotSequence: state.lastSeq,
          mutationSeq: state.mutationSeq,
          visibilitySeq: state.visibilitySeq,
          clearedThroughSequence: state.clearedThroughSequence,
          globalClearedThroughSequence: state.globalClearedThroughSequence,
          hidden: state.hidden,
        }
      },
      resolve: sessionApi.resolveMessages,
    },
    context: (chatId) => ({
      selected: selectedRef.current === chatId,
      readingHistory: isReadingHistory(chatId),
      removed: isRemoved(chatId),
      connected: socketRef.current?.readyState === WebSocket.OPEN,
      room: roomForChat(chatId),
      kind: listChats().find((chat) => chat.id === chatId)?.kind,
    }),
    changed: () => {
      for (const send of requests.list())
        if (
          send.status === 'saved' &&
          send.messageId &&
          send.sequence &&
          !recovery.acceptsSaved(send.chatId, send.messageId, send.sequence)
        )
          requests.revised(send.messageId)
      setMessages(recovery.visibleWindows())
      setLatestSequences(recovery.latestSequences())
    },
    sendFrame: sendConnectedFrame,
    jumped: () => setJumpRevision((value) => value + 1),
    failed: (message) => {
      recoveryFailureRef.current += 1
      focusFreshAtRef.current = 0
      setError(message)
    },
    recovered: (message) => setErrorState((current) => (current === message ? null : current)),
    hidden: hideConversation,
    locationRestored: (chatId) => {
      if (selectedRef.current === chatId) setLocationRevision((value) => value + 1)
    },
  })

  useRecoveryLifecycle({ recovery, selectedId, selectedRef, activeRef, focusRequestRef })

  const catchUp = useCallback(
    (chatId: string, fromStart = false, fresh = false) =>
      recovery.catchUp(chatId, fromStart, '0', false, fresh),
    [recovery],
  )

  const {
    selectResolvedDraft,
    reconcilePending,
    sendMessage: startSend,
    retryMessage,
  } = useMessengerSends({
    pending,
    requests,
    catchUp,
    refreshChats,
    setSelectedId,
    setDraftChat,
    setError,
  })

  const sendMessage = useCallback(
    (chatId: string, body: string, replyToMessageId?: string) => {
      const accepted = startSend(chatId, body, replyToMessageId)
      if (accepted && !chatId.startsWith('draft:')) recovery.beginNavigation()
      return accepted
    },
    [startSend, recovery],
  )

  const applyChatPreferences = useCallback(
    (chatId: string, preferences: ChatPreferences) =>
      applyPreferences(chatId, {
        pinnedRank: preferences.pinnedRank,
        mutedUntil: preferences.mutedUntil,
        mutedForever: preferences.mutedForever,
        markedUnread: preferences.markedUnread,
      }),
    [applyPreferences],
  )
  const pinChat = useCallback(
    async (chatId: string, pinned: boolean) =>
      applyPinnedOrder(await sessionApi.pinChat(chatId, pinned)),
    [applyPinnedOrder, sessionApi],
  )
  const reorderPinnedChats = useCallback(
    async (order: string[]) => {
      applyPinnedOrder(order)
      try {
        applyPinnedOrder(await sessionApi.reorderPinnedChats(order))
      } catch (cause) {
        void refreshChats(false, true)
        throw cause
      }
    },
    [applyPinnedOrder, refreshChats, sessionApi],
  )
  const movePinnedChat = useCallback(
    async (chatId: string, offset: number) => {
      const order = listChats()
        .filter((chat) => chat.pinnedRank != null)
        .map((chat) => chat.id)
      const index = order.indexOf(chatId)
      const target = index + offset
      if (index < 0 || target < 0 || target >= order.length) return
      order.splice(index, 1)
      order.splice(target, 0, chatId)
      await reorderPinnedChats(order)
    },
    [listChats, reorderPinnedChats],
  )
  const muteChat = useCallback(
    async (chatId: string, durationSeconds: number | null) =>
      applyChatPreferences(chatId, await sessionApi.muteChat(chatId, durationSeconds)),
    [applyChatPreferences, sessionApi],
  )
  const unmuteChat = useCallback(
    async (chatId: string) => applyChatPreferences(chatId, await sessionApi.unmuteChat(chatId)),
    [applyChatPreferences, sessionApi],
  )
  const markChatUnread = useCallback(
    async (chat: Chat, unread: boolean) => {
      if (!unread && (chat.unreadCount ?? 0) > 0 && chat.lastSequence !== '0') {
        markRead(chat.id, chat.lastSequence)
        try {
          settleRead(
            chat.id,
            (await sessionApi.advanceRead(chat.id, chat.lastSequence)).throughSequence,
          )
        } catch (cause) {
          settleRead(chat.id)
          throw cause
        }
      }
      if (unread || chat.markedUnread)
        applyChatPreferences(chat.id, await sessionApi.markUnread(chat.id, unread))
    },
    [applyChatPreferences, markRead, sessionApi, settleRead],
  )
  const forwardMessages = useCallback(
    (targetChatId: string, messages: Message[]) => {
      let failed = 0
      const ordered = messages
        .filter((message) => !message.deletedAt)
        .sort((left, right) => (BigInt(left.sequence) < BigInt(right.sequence) ? -1 : 1))
      for (const message of ordered) {
        const source = {
          chatId: message.chatId,
          messageId: message.id,
          authorId: message.forwardedFromUserId ?? message.senderId,
        }
        if (!startSend(targetChatId, message.body, undefined, source)) failed += 1
      }
      if (failed)
        setError(`${failed} ${failed === 1 ? 'message' : 'messages'} could not be forwarded.`)
      return failed === 0
    },
    [setError, startSend],
  )

  const openedRef = useRef<string | null>(null)
  useEffect(() => {
    openedRef.current = selectedId
  }, [selectedId])
  useEffect(() => {
    const opened = openedRef.current
    const chat = opened ? chats.find((item) => item.id === opened) : undefined
    if (!chat) return
    openedRef.current = null
    if (!chat.markedUnread) return
    applyChatPreferences(chat.id, { ...chat, markedUnread: false })
    void sessionApi
      .markUnread(chat.id, false)
      .then((preferences) => applyChatPreferences(chat.id, preferences))
      .catch(() => void refreshChatSummary(chat.id).catch(() => {}))
  }, [chats, selectedId, applyChatPreferences, refreshChatSummary, sessionApi])

  useMessengerSocket({
    onFeatureEvent,
    onSidebarEvent: sidebar.onEvent,
    sessionApi,
    userId: session.user.id,
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
  })

  useMessengerFocus({
    recovery,
    requests,
    selectedRef,
    socketRef,
    activeRef,
    socketGenerationRef,
    focusRequestRef,
    focusFreshAtRef,
    recoveryFailureRef,
    successfulRefreshes,
    refreshChats,
    catchUp,
    reconcilePending,
  })

  const {
    selectChat,
    createDirect,
    createGroup,
    navigationError,
    openingConversation,
    clearNavigationError,
  } = useChatNavigation({
    session,
    sessionApi,
    location,
    selectedRef,
    setSelectedId,
    setDraftChat,
    listChats,
    rememberChat,
    refreshChats,
    leaveHistory,
    catchUp,
    setError,
  })

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (isNetworkOnline()) void refreshChats(true, true)
    }, 30000)
    return () => window.clearInterval(timer)
  }, [refreshChats])

  return {
    sidebarPresence: sidebar.sidebarPresence,
    watchSidebarPeers: sidebar.watchSidebarPeers,
    reconnect: { nextRetryAt },
    retryNow,
    deleteChatById: features.deleteChatById,
    clearChatHistory: features.clearChatHistory,
    features,
    deleteChat: features.deleteChat,
    pins,
    pinChat,
    movePinnedChat,
    reorderPinnedChats,
    muteChat,
    unmuteChat,
    markChatUnread,
    forwardMessages,
    latestMessages: recovery.latestWindows(),
    detached: Boolean(selectedId && recovery.isDetached(selectedId)),
    chats,
    draftChat: draftChat?.id === selectedId ? draftChat : undefined,
    messages,
    pending,
    connection,
    selectedId,
    error: navigationError || error,
    loading: loading || openingConversation,
    hasMoreChats,
    loadingMoreChats,
    loadingOlder: loadingOlder === selectedId,
    loadingNewer: loadingNewer === selectedId,
    jumpRevision,
    location: selectedId ? recovery.readingLocation(selectedId) : undefined,
    locationRevision,
    rememberLocation: useCallback(
      (chatId: string, location: ReadingLocation) => recovery.rememberLocation(chatId, location),
      [recovery],
    ),
    ...historyAvailability(
      selectedId ? (messages[selectedId] ?? []) : [],
      selectedId ? (latestSequences[selectedId] ?? '0') : '0',
      selectedId ? recovery.baseline(selectedId) : '0',
    ),
    ...Object.fromEntries(
      Object.entries(selectedId ? recovery.availability(selectedId) : {}).filter(
        ([, value]) => value !== undefined,
      ),
    ),
    selectChat,
    closeChat,
    setAtLatestPosition,
    sendMessage,
    retryMessage,
    createDirect,
    createGroup,
    refreshChats,
    updateChat: rememberChat,
    lookupUser: sessionApi.user,
    loadMoreChats,
    loadOlder,
    loadNewer,
    showLatest,
    reportError: setError,
    clearError: () => {
      setError(null)
      clearNavigationError()
    },
  }
}
