import { useCallback, useEffect, useRef, useState } from 'react'
import type { Chat } from '../../entities/chat/model'
import type { ChatRecovery } from '../../entities/message/chatRecovery'
import { mergeMessages, type Message } from '../../entities/message/model'
import type { api } from '../../shared/api/http'
import type { OutgoingSocketFrame, PresenceStatus, SocketEvent } from '../../shared/api/socket'
import { MutationRecovery } from './mutationRecovery'

type SessionApi = ReturnType<typeof api.forSession>
interface Options {
  chat?: Chat
  connected: boolean
  recovery: ChatRecovery
  sessionApi: SessionApi
  send(frame: OutgoingSocketFrame): void
  remove(chatId: string): void
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
      changes: (chatId, after) => optionsRef.current.sessionApi.messageChanges(chatId, after),
      patch: (chatId, messages) => optionsRef.current.recovery.patch(chatId, messages),
      reset: async (chatId) => {
        const current = optionsRef.current
        const generation = scope.current
        const active = current.recovery.visibleWindows()[chatId] ?? []
        return (
          (await current.recovery.withHistorySnapshot(
            chatId,
            async () => {
              const requests = [current.sessionApi.latestMessages(chatId)]
              if (active.length)
                for (let index = 0; index < active.length; index += 50)
                  requests.push(
                    current.sessionApi.messages(
                      chatId,
                      (BigInt(active[index].sequence) - 1n).toString(),
                      50,
                    ),
                  )
              const pages = await Promise.all(requests)
              return {
                messages: mergeMessages(
                  [],
                  pages.flatMap((page) => page.messages),
                ),
                mutationRevision: pages.reduce(
                  (min, page) =>
                    BigInt(page.mutationRevision ?? '0') < BigInt(min)
                      ? (page.mutationRevision ?? '0')
                      : min,
                  pages[0].mutationRevision ?? '0',
                ),
              }
            },
            (page) => {
              if (generation !== scope.current || optionsRef.current.chat?.id !== chatId) return '0'
              current.recovery.patch(chatId, page.messages)
              return page.mutationRevision
            },
          )) ?? '0'
        )
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
      if (event.type === 'chat_deleted') {
        current.remove(event.chatId)
        return true
      }
      if (event.type === 'message_changed') {
        const {
          type: _type,
          eventId: _event,
          room: _room,
          epoch: _epoch,
          streamId: _stream,
          version: _version,
          mutationRevision: _mutation,
          messageId,
          ...message
        } = event
        current.recovery.patch(event.chatId, [{ ...message, id: messageId }])
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
          if (generation !== scope.current || page.anchorMessageId !== messageId) return
          if (current.recovery.reveal(id, page.messages, revision))
            setReveal({ messageId, revision, focus })
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
  const deleteChat = useCallback(async (chatId: string) => {
    const current = optionsRef.current
    await current.sessionApi.deleteChat(chatId)
    current.remove(chatId)
  }, [])
  return {
    deleteChat,
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
