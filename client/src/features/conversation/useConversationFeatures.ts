import { useCallback, useEffect, useRef, useState } from 'react'
import type { Chat } from '../../entities/chat/model'
import type { ChatRecovery } from '../../entities/message/chatRecovery'
import type { DeleteScope, DeleteTarget } from '../../entities/message/historySnapshot'
import { type Message } from '../../entities/message/model'
import type { api } from '../../shared/api/http'
import type { OutgoingSocketFrame, PresenceStatus, SocketEvent } from '../../shared/api/socket'
import { createUlid } from '../../shared/lib/id'
import { MutationRecovery } from './mutationRecovery'

type SessionApi = ReturnType<typeof api.forSession>
interface Options {
  chat?: Chat
  connected: boolean
  recovery: ChatRecovery
  sessionApi: SessionApi
  send(frame: OutgoingSocketFrame): void
  remove(chatId: string): void
  hide?(chatId: string): void
  fail(message: string): void
}

export function useConversationFeatures(options: Options) {
  const optionsRef = useRef(options)
  optionsRef.current = options
  const [watchTargets, setWatchTargets] = useState<string[] | null>(null)
  const [presence, setPresence] = useState<Record<string, PresenceStatus['state']>>({})
  const [summary, setSummary] = useState({ throughSequence: '0', maxOtherReadSequence: '0' })
  const [reveal, setReveal] = useState<{
    messageId: string
    revision: number
    focus: boolean
  } | null>(null)
  const [jumpLoading, setJumpLoading] = useState<string | null>(null)
  const scope = useRef(0)
  const presenceAt = useRef(0)
  const presenceExpiry = useRef<ReturnType<typeof setTimeout>>()
  const jumpRequest = useRef(0)
  const readPending = useRef('0')
  const readNextAt = useRef(0)
  const readTimer = useRef<ReturnType<typeof setTimeout>>()
  const readRunning = useRef(false)
  const readRefreshing = useRef(false)
  const mutationBusy = useRef(new Set<string>())
  const reconcileRef = useRef<MutationRecovery | null>(null)
  if (!reconcileRef.current)
    reconcileRef.current = new MutationRecovery({
      changes: (chatId, after) =>
        optionsRef.current.recovery.fetchChanges(chatId, () =>
          optionsRef.current.sessionApi.messageChanges(chatId, after),
        ),
      patch: (chatId, messages) => optionsRef.current.recovery.patch(chatId, messages),
      apply: (chatId, changes, snapshot) =>
        optionsRef.current.recovery.applyChanges(chatId, changes, snapshot),
      reset: async (chatId) => {
        await optionsRef.current.recovery.synchronize(chatId)
        return optionsRef.current.recovery.mutationRevision(chatId)
      },
    })
  const chatId = options.chat?.id.startsWith('draft:') ? undefined : options.chat?.id
  const refreshReads = useCallback(async () => {
    const current = optionsRef.current
    const id = current.chat?.id
    const generation = scope.current
    if (!id || id.startsWith('draft:') || readRefreshing.current) return
    readRefreshing.current = true
    try {
      const result = await current.sessionApi.reads(id)
      if (generation !== scope.current) return
      setSummary((previous) => ({
        throughSequence:
          BigInt(result.throughSequence) > BigInt(previous.throughSequence)
            ? result.throughSequence
            : previous.throughSequence,
        maxOtherReadSequence: result.maxOtherReadSequence,
      }))
    } catch {
    } finally {
      if (generation === scope.current) readRefreshing.current = false
    }
  }, [])
  const flushRead = useCallback(async () => {
    if (readRunning.current || !optionsRef.current.connected) return
    const current = optionsRef.current
    const id = current.chat?.id
    const generation = scope.current
    if (!id || id.startsWith('draft:')) return
    readRunning.current = true
    try {
      while (readPending.current !== '0' && generation === scope.current) {
        const wait = readNextAt.current - Date.now()
        if (wait > 0) {
          if (readTimer.current === undefined)
            readTimer.current = setTimeout(() => {
              readTimer.current = undefined
              if (generation === scope.current) void flushRead()
            }, wait)
          return
        }
        const through = readPending.current
        readNextAt.current = Date.now() + 1000
        const result = await current.sessionApi.advanceRead(id, through)
        if (generation !== scope.current) return
        if (BigInt(readPending.current) <= BigInt(result.throughSequence)) readPending.current = '0'
        setSummary((previous) => ({
          ...previous,
          throughSequence:
            BigInt(result.throughSequence) > BigInt(previous.throughSequence)
              ? result.throughSequence
              : previous.throughSequence,
        }))
      }
    } catch {
    } finally {
      if (generation === scope.current) readRunning.current = false
    }
  }, [])
  const readThrough = useCallback(
    (through: string) => {
      if (BigInt(through) > BigInt(readPending.current)) readPending.current = through
      void flushRead()
    },
    [flushRead],
  )
  const watchedRef = useRef<string[]>([])
  const memberKey =
    watchTargets?.join(',') ??
    options.chat?.members
      .slice(0, 100)
      .map((member) => member.id)
      .sort()
      .join(',') ??
    ''
  watchedRef.current = memberKey ? memberKey.split(',') : []
  useEffect(() => {
    scope.current += 1
    readPending.current = '0'
    readNextAt.current = 0
    clearTimeout(readTimer.current)
    readTimer.current = undefined
    readRunning.current = false
    readRefreshing.current = false
    setWatchTargets(null)
    presenceAt.current = 0
    clearTimeout(presenceExpiry.current)
    mutationBusy.current.clear()
    setPresence({})
    setSummary({ throughSequence: '0', maxOtherReadSequence: '0' })
    setReveal(null)
    setJumpLoading(null)
    reconcileRef.current!.select(chatId ?? null)
    return () => {
      clearTimeout(readTimer.current)
      readTimer.current = undefined
      clearTimeout(presenceExpiry.current)
      scope.current += 1
    }
  }, [chatId])
  useEffect(() => {
    if (!chatId || !options.connected) {
      clearTimeout(presenceExpiry.current)
      setPresence({})
      return
    }
    setPresence((previous) =>
      Object.fromEntries(
        Object.entries(previous).filter(([id]) => watchedRef.current.includes(id)),
      ),
    )
    const watch = () =>
      optionsRef.current.send({
        type: 'watch_presence',
        version: 1,
        chatId,
        userIds: memberKey ? memberKey.split(',') : [],
      })
    const refresh = () => {
      watch()
      void refreshReads()
      void flushRead()
      void reconcileRef.current!.refresh().catch(() => {})
      void optionsRef.current.recovery.synchronize(chatId)
    }
    refresh()
    const timer = window.setInterval(refresh, 12000 + Math.random() * 3000)
    const focus = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    window.addEventListener('focus', focus)
    document.addEventListener('visibilitychange', focus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', focus)
      document.removeEventListener('visibilitychange', focus)
      optionsRef.current.send({ type: 'unwatch_presence', version: 1 })
    }
  }, [chatId, memberKey, options.connected, refreshReads, flushRead])
  const onEvent = useCallback(
    (event: SocketEvent): boolean => {
      const current = optionsRef.current
      if (event.type === 'history_changed') {
        void current.recovery.synchronize(event.chatId, {
          snapshotSequence: event.sequence,
          mutationRevision: event.mutationRevision,
          visibilityRevision: event.visibilityRevision,
        })
        return true
      }
      if (event.type === 'chat_deleted') {
        current.remove(event.chatId)
        return true
      }
      if (event.type === 'message_changed') {
        void current.recovery.synchronize(event.chatId, {
          mutationRevision: event.mutationRevision,
        })
        return true
      }
      if (event.type === 'reads_changed') {
        if (event.chatId === current.chat?.id) void refreshReads()
        return true
      }
      if (event.type === 'presence') {
        if (
          event.chatId !== current.chat?.id ||
          !current.connected ||
          Date.parse(event.observedAt) < presenceAt.current
        )
          return true
        const observedAt = Date.parse(event.observedAt)
        if (Date.now() - observedAt > event.validForMs || observedAt > Date.now() + 30000)
          return true
        presenceAt.current = observedAt
        clearTimeout(presenceExpiry.current)
        presenceExpiry.current = setTimeout(() => setPresence({}), event.validForMs)
        const members = new Set(watchedRef.current)
        setPresence((previous) => ({
          ...previous,
          ...Object.fromEntries(
            event.statuses
              .filter((status) => members.has(status.userId))
              .map((status) => [status.userId, status.state]),
          ),
        }))
        return true
      }
      if (event.type === 'recovery_failed') void reconcileRef.current!.refresh().catch(() => {})
      return false
    },
    [refreshReads],
  )
  const snapshot = useCallback((id: string, revision: string) => {
    reconcileRef.current!.snapshot(id, revision)
    void reconcileRef.current!.refresh().catch(() => {})
  }, [])
  const jumpToMessage = useCallback(async (messageId: string, focus: boolean) => {
    const current = optionsRef.current
    const id = current.chat?.id
    if (!id) return
    const revision = current.recovery.beginNavigation()
    const generation = scope.current
    jumpRequest.current = revision
    const visible = current.recovery.visibleWindows()[id] ?? []
    const pinned = current.recovery.latestWindows()[id] ?? []
    if (visible.some((message) => message.id === messageId)) {
      setReveal({ messageId, revision, focus })
      setJumpLoading(null)
      return
    }
    if (
      pinned.some((message) => message.id === messageId) &&
      current.recovery.reveal(id, pinned, revision)
    ) {
      setReveal({ messageId, revision, focus })
      setJumpLoading(null)
      return
    }
    setJumpLoading(messageId)
    try {
      await current.recovery.withHistorySnapshot(
        id,
        () => current.sessionApi.aroundMessage(id, messageId),
        (page) => {
          if (generation !== scope.current || !page.anchorMessageId) return
          if (current.recovery.reveal(id, page.messages, revision, page))
            setReveal({ messageId: page.anchorMessageId, revision, focus })
        },
      )
    } catch (cause) {
      if (generation === scope.current)
        current.fail(cause instanceof Error ? cause.message : 'Could not find the original message')
    } finally {
      if (generation === scope.current && jumpRequest.current === revision)
        setJumpLoading((previous) => (previous === messageId ? null : previous))
    }
  }, [])
  const mutate = useCallback(async (message: Message, body?: string) => {
    if (mutationBusy.current.has(message.id))
      throw new Error('This message is already being updated')
    const current = optionsRef.current
    const generation = scope.current
    mutationBusy.current.add(message.id)
    try {
      const result =
        body === undefined
          ? await current.sessionApi.deleteMessage(
              message.chatId,
              message.id,
              message.messageVersion ?? '1',
            )
          : await current.sessionApi.editMessage(
              message.chatId,
              message.id,
              body,
              message.messageVersion ?? '1',
            )
      if (generation === scope.current) current.recovery.patch(message.chatId, [result])
    } finally {
      mutationBusy.current.delete(message.id)
    }
  }, [])
  const deletionRequests = useRef(new Map<string, string>())
  const deletion = useCallback(
    async (target: DeleteTarget, scope: DeleteScope, messages?: Message[]) => {
      const current = optionsRef.current
      const id = current.chat?.id
      if (!id || id.startsWith('draft:')) throw new Error('Choose a saved chat')
      const ids = messages ? [...new Set(messages.map((message) => message.id))].sort() : undefined
      if (
        target === 'MESSAGES' &&
        (!ids?.length || ids.length > 100 || messages?.some((message) => message.chatId !== id))
      )
        throw new Error('Choose up to 100 messages from this chat')
      const key = JSON.stringify([id, scope, target, ids])
      const requestId = deletionRequests.current.get(key) ?? createUlid()
      deletionRequests.current.set(key, requestId)
      if (deletionRequests.current.size > 100)
        deletionRequests.current.delete(deletionRequests.current.keys().next().value!)
      const result = await current.sessionApi.delete(id, requestId, scope, target, ids)
      deletionRequests.current.delete(key)
      current.recovery.observe(id, {
        mutationRevision: result.mutationRevision,
        visibilityRevision: result.visibilityRevision,
        ...(scope === 'SELF'
          ? { clearedThroughSequence: result.clearedThroughSequence }
          : { globalClearedThroughSequence: result.clearedThroughSequence }),
      })
      if (target === 'CHAT' && scope === 'EVERYONE') current.remove(id)
      else {
        await current.recovery.synchronize(id)
        if (target === 'CHAT') current.hide?.(id)
      }
    },
    [],
  )
  const deleteChat = useCallback((scope: DeleteScope) => deletion('CHAT', scope), [deletion])
  const clearHistory = useCallback((scope: DeleteScope) => deletion('HISTORY', scope), [deletion])
  const deleteMessages = useCallback(
    (messages: Message[], scope: DeleteScope) => deletion('MESSAGES', scope, messages),
    [deletion],
  )

  return {
    revisionKey: chatId ? options.recovery.revisionKey(chatId) : '0:0',
    resolveTarget: useCallback(async (messageId: string) => {
      const current = optionsRef.current
      const id = current.chat?.id
      const generation = scope.current
      if (!id || id.startsWith('draft:')) return undefined
      const message = await current.recovery.resolveTarget(id, messageId)
      if (generation !== scope.current)
        throw new Error('Conversation changed while loading the message')
      return message
    }, []),
    deleteChat,
    clearHistory,
    deleteMessages,
    presence: options.connected ? presence : {},
    watchMembers: useCallback(
      (ids: string[] | null) =>
        setWatchTargets(ids ? [...new Set(ids)].slice(0, 100).sort() : null),
      [],
    ),
    summary,
    reveal,
    jumpLoading,
    readThrough,
    onEvent,
    snapshot,
    jumpToMessage,
    editMessage: (message: Message, body: string) => mutate(message, body),
    deleteMessage: (message: Message) => mutate(message),
    readers: options.sessionApi.messageReaders,
  }
}
