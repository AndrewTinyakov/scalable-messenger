import { useCallback, useEffect, useRef, useState } from 'react'
import type { Chat } from '../../entities/chat/model'
import type { ChatRecovery } from '../../entities/message/chatRecovery'
import type { DeleteScope, DeleteTarget } from '../../entities/message/historySnapshot'
import { isContiguous } from '../../entities/message/historyWindow'
import { type Message } from '../../entities/message/model'
import type { ChatState } from '../../shared/api/featureDecode'
import { ChatKind } from '../../shared/api/generated/socket-vocabulary'
import { ApiError, type api } from '../../shared/api/http'
import type { OutgoingSocketFrame, PresenceStatus, SocketEvent } from '../../shared/api/socket'
import { createUlid } from '../../shared/lib/id'
import { isId } from '../../shared/lib/validation'
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
  refreshChats?(): Promise<unknown>
  onReadPending?(chatId: string, through: string): void
  onReadCommitted?(chatId: string, through: string): void
  onReadFailed?(chatId: string): void
  fail(message: string): void
  sharedPresence?: Record<string, PresenceStatus['state']>
}

const STATE_CHECK_MS = 60_000

export type StateRequest = {
  visit: number
  hint: number
  floors?: { minSeq: string; minMemberSeq: string }
}

type ReadWrite =
  { phase: 'idle' | 'sending' } | { phase: 'waiting'; timer: ReturnType<typeof setTimeout> }

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
  const readWrite = useRef<ReadWrite>({ phase: 'idle' })
  const mutationBusy = useRef(new Set<string>())
  const reconcileRef = useRef<MutationRecovery | null>(null)
  const knownSeq = useRef({
    chatId: '',
    visit: 0,
    seeded: false,
    seq: 0n,
    memberSeq: 0n,
    primaryHint: 0,
  })
  const [pinsState, setPinsState] = useState({ key: '', tick: 0 })
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
        return optionsRef.current.recovery.mutationSeq(chatId)
      },
    })
  const chatId = options.chat?.id.startsWith('draft:') ? undefined : options.chat?.id
  const checkState = useCallback((id: string, primary = false) => {
    if (primary && knownSeq.current.chatId === id) knownSeq.current.primaryHint += 1
    void optionsRef.current.recovery.synchronize(id)
  }, [])
  const observeCounters = useCallback((id: string, seq?: string, memberSeq?: string): boolean => {
    const known = knownSeq.current
    if (known.chatId !== id) return false
    let gap = false
    if (seq !== undefined) {
      const value = BigInt(seq)
      gap ||= known.seeded && value > known.seq + 1n
      if (value > known.seq) known.seq = value
    }
    if (memberSeq !== undefined) {
      const value = BigInt(memberSeq)
      gap ||= known.seeded && value > known.memberSeq + 1n
      if (value > known.memberSeq) known.memberSeq = value
    }
    return gap
  }, [])
  const observeState = useCallback((id: string, state: ChatState, request: StateRequest) => {
    const known = knownSeq.current
    if (known.chatId !== id || known.visit !== request.visit) return
    known.seeded = true
    const fromPrimary = request.floors === undefined
    if (fromPrimary && request.hint === known.primaryHint) known.primaryHint = 0
    if (BigInt(state.lastSeq) > known.seq) known.seq = BigInt(state.lastSeq)
    if (BigInt(state.memberSeq) > known.memberSeq) known.memberSeq = BigInt(state.memberSeq)
    setPinsState((previous) => ({
      key: `${state.pinsSeq}:${state.memberPinsSeq}:${state.mutationSeq}`,
      tick: previous.tick + 1,
    }))
    setSummary((previous) => ({
      throughSequence:
        BigInt(state.ownReadThrough) > BigInt(previous.throughSequence)
          ? state.ownReadThrough
          : previous.throughSequence,
      maxOtherReadSequence:
        fromPrimary || BigInt(state.otherReadThrough) > BigInt(previous.maxOtherReadSequence)
          ? state.otherReadThrough
          : previous.maxOtherReadSequence,
    }))
    if (reconcileRef.current!.behind(id, state.mutationSeq))
      void reconcileRef.current!.refresh().catch(() => {})
  }, [])
  const stateRequest = useCallback((id: string): StateRequest => {
    const known = knownSeq.current
    if (known.chatId !== id) return { visit: -1, hint: 0 }
    if (!known.seeded || known.primaryHint > 0)
      return { visit: known.visit, hint: known.primaryHint }
    return {
      visit: known.visit,
      hint: 0,
      floors: { minSeq: known.seq.toString(), minMemberSeq: known.memberSeq.toString() },
    }
  }, [])
  const flushRead = useCallback(async () => {
    if (readWrite.current.phase !== 'idle' || !optionsRef.current.connected) return
    const current = optionsRef.current
    const id = current.chat?.id
    const generation = scope.current
    if (!id || id.startsWith('draft:')) return
    const sending: ReadWrite = { phase: 'sending' }
    readWrite.current = sending
    try {
      while (readPending.current !== '0' && generation === scope.current) {
        const wait = readNextAt.current - Date.now()
        if (wait > 0) {
          readWrite.current = {
            phase: 'waiting',
            timer: setTimeout(() => {
              if (generation !== scope.current) return
              readWrite.current = { phase: 'idle' }
              void flushRead()
            }, wait),
          }
          return
        }
        const through = readPending.current
        readNextAt.current = Date.now() + 1000
        const result = await current.sessionApi.advanceRead(id, through)
        current.onReadCommitted?.(id, result.throughSequence)
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
      current.onReadFailed?.(id)
    } finally {
      if (generation === scope.current && readWrite.current === sending)
        readWrite.current = { phase: 'idle' }
    }
  }, [])
  const readThrough = useCallback(
    (through: string) => {
      const id = optionsRef.current.chat?.id
      if (id && !id.startsWith('draft:')) optionsRef.current.onReadPending?.(id, through)
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
  const sharesPresence =
    options.sharedPresence !== undefined &&
    options.chat?.kind === ChatKind.DIRECT &&
    isId(options.chat.id)
  useEffect(() => {
    scope.current += 1
    readPending.current = '0'
    readNextAt.current = 0
    if (readWrite.current.phase === 'waiting') clearTimeout(readWrite.current.timer)
    readWrite.current = { phase: 'idle' }
    setWatchTargets(null)
    presenceAt.current = 0
    clearTimeout(presenceExpiry.current)
    mutationBusy.current.clear()
    setPresence({})
    setSummary({ throughSequence: '0', maxOtherReadSequence: '0' })
    knownSeq.current = {
      chatId: chatId ?? '',
      visit: knownSeq.current.visit + 1,
      seeded: false,
      seq: 0n,
      memberSeq: 0n,
      primaryHint: 0,
    }
    setPinsState((previous) => ({ key: '', tick: previous.tick + 1 }))
    setReveal(null)
    setJumpLoading(null)
    reconcileRef.current!.select(chatId ?? null)
    return () => {
      if (readWrite.current.phase === 'waiting') clearTimeout(readWrite.current.timer)
      readWrite.current = { phase: 'idle' }
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
    const watch = () => {
      if (sharesPresence) return
      optionsRef.current.send({
        type: 'watch_presence',
        version: 1,
        chatId,
        userIds: memberKey ? memberKey.split(',') : [],
      })
    }
    const renew = () => {
      watch()
      void flushRead()
    }
    const refresh = () => {
      renew()
      checkState(chatId)
    }
    refresh()
    const timer = window.setInterval(renew, 12000 + Math.random() * 3000)
    const stateTimer = window.setInterval(() => checkState(chatId), STATE_CHECK_MS)
    const focus = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    window.addEventListener('focus', focus)
    document.addEventListener('visibilitychange', focus)
    return () => {
      window.clearInterval(timer)
      window.clearInterval(stateTimer)
      window.removeEventListener('focus', focus)
      document.removeEventListener('visibilitychange', focus)
      if (!sharesPresence) optionsRef.current.send({ type: 'unwatch_presence', version: 1 })
    }
  }, [chatId, memberKey, sharesPresence, options.connected, checkState, flushRead])
  const onEvent = useCallback(
    (event: SocketEvent): boolean => {
      const current = optionsRef.current
      if ('chatId' in event && typeof event.chatId === 'string') {
        const seq =
          event.type === 'message_saved'
            ? event.sequence
            : 'seq' in event && typeof event.seq === 'string'
              ? event.seq
              : undefined
        const memberSeq =
          'memberSeq' in event && typeof event.memberSeq === 'string' ? event.memberSeq : undefined
        if (observeCounters(event.chatId, seq, memberSeq)) checkState(event.chatId)
      }
      if (event.type === 'history_changed') {
        void current.recovery.synchronize(event.chatId, {
          snapshotSequence: event.sequence,
          mutationSeq: event.seq,
          visibilitySeq: event.memberSeq,
        })
        return true
      }
      if (event.type === 'chat_deleted') {
        current.remove(event.chatId)
        return true
      }
      if (event.type === 'message_changed') {
        void current.recovery.synchronize(event.chatId, {
          mutationSeq: event.seq,
        })
        return true
      }
      if (event.type === 'reads_changed') {
        if (event.chatId === current.chat?.id) checkState(event.chatId, true)
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
      if (event.type === 'recovery_failed') {
        void reconcileRef.current!.refresh().catch(() => {})
        if (event.chatId === current.chat?.id) checkState(event.chatId)
      }
      return false
    },
    [checkState, observeCounters],
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
      isContiguous(pinned) &&
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
      if (generation !== scope.current) return
      if (cause instanceof ApiError && cause.status === 404)
        current.recovery.quoteTargetGone(id, messageId)
      else
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
    } catch (cause) {
      if (
        cause instanceof ApiError &&
        cause.code === 'VERSION_CHANGED' &&
        generation === scope.current
      )
        await current.recovery.synchronize(message.chatId).catch(() => undefined)
      throw cause
    } finally {
      mutationBusy.current.delete(message.id)
    }
  }, [])
  const deletionRequests = useRef(new Map<string, string>())
  const deletion = useCallback(
    async (target: DeleteTarget, scope: DeleteScope, messages?: Message[], chatId?: string) => {
      const current = optionsRef.current
      const id = chatId ?? current.chat?.id
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
      const result = await current.sessionApi
        .delete(id, requestId, scope, target, ids)
        .catch((cause: unknown) => {
          if (cause instanceof ApiError && cause.code === 'REQUEST_ID_REUSED')
            deletionRequests.current.delete(key)
          throw cause
        })
      deletionRequests.current.delete(key)
      current.recovery.observe(id, {
        ...(scope === 'EVERYONE' ? { mutationSeq: result.seq } : {}),
        visibilitySeq: result.visibilitySeq,
        ...(scope === 'SELF'
          ? { clearedThroughSequence: result.clearedThroughSequence }
          : { globalClearedThroughSequence: result.clearedThroughSequence }),
      })
      if (target === 'CHAT' && scope === 'EVERYONE') current.remove(id)
      else {
        if (id === optionsRef.current.chat?.id) await current.recovery.synchronize(id)
        if (target === 'CHAT') current.hide?.(id)
        else await current.refreshChats?.()
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
    pinsState,
    observeState,
    stateRequest,
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
    deleteChatById: useCallback(
      (id: string, scope: DeleteScope) => deletion('CHAT', scope, undefined, id),
      [deletion],
    ),
    clearChatHistory: useCallback(
      (id: string, scope: DeleteScope) => deletion('HISTORY', scope, undefined, id),
      [deletion],
    ),
    clearHistory,
    deleteMessages,
    presence: !options.connected ? {} : sharesPresence ? (options.sharedPresence ?? {}) : presence,
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
