import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { Chat } from '../entities/chat/model'
import { ChatKind } from '../shared/api/generated/socket-vocabulary'
import { ApiError, type api } from '../shared/api/http'

type SessionApi = ReturnType<typeof api.forSession>

interface ChatDirectoryOptions {
  sessionApi: SessionApi
  selectedId: string | null
  selectedIdRef: MutableRefObject<string | null>
  recordLatest(chatId: string, sequence: string): void
  onRefreshed(chats: Chat[]): void
  setError(message: string | null): void
}

export function useChatDirectory({
  sessionApi,
  selectedId,
  selectedIdRef,
  recordLatest,
  onRefreshed,
  setError,
}: ChatDirectoryOptions) {
  const [chats, setChats] = useState<Chat[]>([])
  const [nextChatCursor, setNextChatCursor] = useState<string | null>(null)
  const [loadingMoreChats, setLoadingMoreChats] = useState(false)
  const [loading, setLoading] = useState(true)
  const chatsRef = useRef(chats)
  const removedChatRef = useRef(new Set<string>())
  const removalGenerationRef = useRef(0)
  const refreshGenerationRef = useRef(0)
  const refreshRequestRef = useRef<{
    promise: Promise<Chat[]>
    invalidated: boolean
    full: boolean
  } | null>(null)
  const refreshSuccessRef = useRef(0)
  const activeRef = useRef(true)

  useEffect(() => {
    activeRef.current = true
    return () => {
      activeRef.current = false
      refreshGenerationRef.current += 1
      refreshRequestRef.current = null
    }
  }, [sessionApi])

  const fetchChats = useCallback(
    async (full = false) => {
      const refreshGeneration = ++refreshGenerationRef.current
      try {
        const removalGeneration = removalGenerationRef.current
        const previouslyLoaded = chatsRef.current
        const target = full ? Math.max(100, previouslyLoaded.length) : 100
        const list: Chat[] = []
        const seen = new Set<string>()
        const cursors = new Set<string>()
        let cursor: string | null = null
        do {
          const page = await sessionApi.chats(cursor || undefined)
          for (const chat of page.chats) {
            if (seen.has(chat.id)) continue
            seen.add(chat.id)
            list.push(chat)
          }
          cursor = page.nextCursor
          if (cursor && cursors.has(cursor)) throw new Error('Chat cursor repeated')
          if (cursor) cursors.add(cursor)
        } while (cursor && list.length < target)
        const current = chatsRef.current.find((chat) => chat.id === selectedIdRef.current)
        let removedSelected = false
        if (current && (current.kind === ChatKind.GROUP || !seen.has(current.id))) {
          const index = list.findIndex((chat) => chat.id === current.id)
          try {
            const opened = await sessionApi.chat(current.id)
            if (index >= 0) list[index] = opened
            else list.push(opened)
            seen.add(current.id)
          } catch (cause) {
            removedSelected = cause instanceof ApiError && cause.status === 404
            if (removedSelected) {
              if (index >= 0) list.splice(index, 1)
              seen.delete(current.id)
            } else if (index >= 0) {
              list[index] = { ...list[index], members: current.members }
            } else {
              list.push(current)
              seen.add(current.id)
            }
          }
        }
        if (!activeRef.current || refreshGeneration !== refreshGenerationRef.current)
          return chatsRef.current
        const fresh = list.filter(
          (chat) =>
            !removedChatRef.current.has(chat.id) ||
            removalGeneration === removalGenerationRef.current,
        )
        for (const chat of fresh) removedChatRef.current.delete(chat.id)
        const merged = full
          ? fresh
          : [
              ...fresh,
              ...previouslyLoaded.filter(
                (chat) =>
                  !seen.has(chat.id) &&
                  !removedChatRef.current.has(chat.id) &&
                  !(removedSelected && chat.id === current?.id),
              ),
            ]
        chatsRef.current = merged
        refreshSuccessRef.current += 1
        setChats(merged)
        for (const chat of fresh) recordLatest(chat.id, chat.lastSequence)
        if (full || previouslyLoaded.length === 0) setNextChatCursor(cursor)
        onRefreshed(merged)
        setError(null)
        return merged
      } catch (cause) {
        if (activeRef.current && refreshGeneration === refreshGenerationRef.current)
          setError(cause instanceof Error ? cause.message : 'Could not load chats')
        return chatsRef.current
      } finally {
        if (activeRef.current && refreshGeneration === refreshGenerationRef.current)
          setLoading(false)
      }
    },
    [onRefreshed, recordLatest, selectedIdRef, sessionApi, setError],
  )

  const refreshChats = useCallback(
    (full = false, invalidated = false): Promise<Chat[]> => {
      const current = refreshRequestRef.current
      if (current) {
        if (invalidated || (full && !current.full)) current.invalidated = true
        current.full ||= full
        return current.promise
      }
      const request = { promise: Promise.resolve(chatsRef.current), invalidated: false, full }
      refreshRequestRef.current = request
      request.promise = (async () => {
        let result: Chat[]
        do {
          request.invalidated = false
          result = await fetchChats(request.full)
        } while (refreshRequestRef.current === request && request.invalidated)
        return result
      })().finally(() => {
        if (refreshRequestRef.current === request) refreshRequestRef.current = null
      })
      return request.promise
    },
    [fetchChats],
  )

  const loadMoreChats = useCallback(async () => {
    if (!nextChatCursor || loadingMoreChats) return
    setLoadingMoreChats(true)
    try {
      const page = await sessionApi.chats(nextChatCursor)
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
  }, [loadingMoreChats, nextChatCursor, recordLatest, sessionApi, setError])

  useEffect(() => {
    const chat = chats.find((item) => item.id === selectedId)
    if (!chat || chat.kind !== ChatKind.GROUP || chat.members.length > 0) return
    let active = true
    void sessionApi
      .chat(chat.id)
      .then((opened) => {
        if (!active) return
        const next = chatsRef.current.map((item) =>
          item.id === opened.id ? { ...item, members: opened.members } : item,
        )
        chatsRef.current = next
        setChats(next)
      })
      .catch(() => {
        /* A later chat refresh or selection retries. */
      })
    return () => {
      active = false
    }
  }, [chats, selectedId, sessionApi])

  useEffect(() => {
    void refreshChats()
  }, [refreshChats])

  const listChats = useCallback(() => chatsRef.current, [])
  const rememberChat = useCallback(
    (chat: Chat) => {
      const next = [chat, ...chatsRef.current.filter((item) => item.id !== chat.id)]
      chatsRef.current = next
      setChats(next)
      recordLatest(chat.id, chat.lastSequence)
    },
    [recordLatest],
  )
  const refreshChatSummary = useCallback(
    async (chatId: string) => {
      const generation = removalGenerationRef.current
      const chat = await sessionApi.chat(chatId)
      if (
        !activeRef.current ||
        generation !== removalGenerationRef.current ||
        removedChatRef.current.has(chatId)
      )
        return
      const next = chatsRef.current.map((item) =>
        item.id === chatId
          ? { ...item, lastMessage: chat.lastMessage, lastSequence: chat.lastSequence, unreadCount: chat.unreadCount, unreadCountCapped: chat.unreadCountCapped }
          : item,
      )
      chatsRef.current = next
      setChats(next)
      recordLatest(chatId, chat.lastSequence)
    },
    [sessionApi, recordLatest],
  )
  const isRemoved = useCallback((chatId: string) => removedChatRef.current.has(chatId), [])
  const successfulRefreshes = useCallback(() => refreshSuccessRef.current, [])
  const removeChat = useCallback((chatId: string) => {
    removedChatRef.current.add(chatId)
    removalGenerationRef.current += 1
    const remaining = chatsRef.current.filter((chat) => chat.id !== chatId)
    chatsRef.current = remaining
    setChats(remaining)
    return remaining
  }, [])

  return {
    chats,
    loading,
    loadingMoreChats,
    hasMoreChats: nextChatCursor !== null,
    refreshChats,
    loadMoreChats,
    listChats,
    rememberChat,
    refreshChatSummary,
    isRemoved,
    successfulRefreshes,
    removeChat,
  }
}
