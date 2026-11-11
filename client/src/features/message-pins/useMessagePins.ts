import { useCallback, useEffect, useRef, useState } from 'react'
import type { Message } from '../../entities/message/model'
import { EventType } from '../../shared/api/generated/socket-vocabulary'
import type { api } from '../../shared/api/http'
import type { SocketEvent } from '../../shared/api/socket'

type SessionApi = ReturnType<typeof api.forSession>
export type PinScope = 'SELF' | 'EVERYONE'
export interface PinnedEntry {
  message: Message
  scope: PinScope
}
interface PinsState {
  chatId: string
  pins: PinnedEntry[]
  total: number
  ids: string[]
  next: string | null
}

type PinRefresh =
  { phase: 'idle' } | { phase: 'refreshing' | 'invalidated'; promise: Promise<void> }

const REFRESH_DELAY_MS = 250

export function useMessagePins(
  chatId: string | undefined,
  sessionApi: SessionApi,
  connected: boolean,
) {
  const [state, setState] = useState<PinsState | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const [loadingOlder, setLoadingOlder] = useState(false)
  const generation = useRef(0)
  const chatRef = useRef(chatId)
  chatRef.current = chatId
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const refreshState = useRef<PinRefresh>({ phase: 'idle' })
  const wanted = useRef(0)

  const refresh = useCallback(async () => {
    const id = chatRef.current
    if (!id || id.startsWith('draft:')) return
    if (refreshState.current.phase !== 'idle') {
      refreshState.current.phase = 'invalidated'
      return refreshState.current.promise
    }
    const current = generation.current
    const operation: Exclude<PinRefresh, { phase: 'idle' }> = {
      phase: 'refreshing',
      promise: Promise.resolve(),
    }
    refreshState.current = operation
    operation.promise = (async () => {
      try {
        do {
          operation.phase = 'refreshing'
          let page = await sessionApi.pinnedMessages(id)
          if (current !== generation.current) return
          const ids = page.pinnedMessageIds.join()
          const pins = [...page.pins]
          let consistent = true
          while (consistent && page.nextBeforeSequence && pins.length < wanted.current) {
            page = await sessionApi.pinnedMessages(id, page.nextBeforeSequence)
            if (current !== generation.current) return
            consistent = page.pinnedMessageIds.join() === ids
            pins.push(
              ...page.pins.filter(
                (pin) => !pins.some((item) => item.message.id === pin.message.id),
              ),
            )
          }
          if (!consistent) {
            operation.phase = 'invalidated'
            continue
          }
          setState({
            chatId: id,
            pins,
            total: page.totalCount,
            ids: page.pinnedMessageIds,
            next: page.nextBeforeSequence,
          })
          if (pins.length >= wanted.current || !page.nextBeforeSequence) setLoadingOlder(false)
        } while (operation.phase === 'invalidated' && current === generation.current)
      } catch {
      } finally {
        if (refreshState.current === operation) refreshState.current = { phase: 'idle' }
      }
    })()
    return operation.promise
  }, [sessionApi])

  const schedule = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void refresh(), REFRESH_DELAY_MS)
  }, [refresh])

  useEffect(() => {
    generation.current += 1
    refreshState.current = { phase: 'idle' }
    wanted.current = 0
    setState(null)
    setLoadingOlder(false)
    clearTimeout(timer.current)
    if (chatId && !chatId.startsWith('draft:') && connected) void refresh()
    return () => clearTimeout(timer.current)
  }, [chatId, connected, refresh])

  useEffect(() => {
    if (!chatId || chatId.startsWith('draft:') || !connected) return
    const timer = window.setInterval(() => void refresh(), 12000 + Math.random() * 3000)
    const focus = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    window.addEventListener('focus', focus)
    document.addEventListener('visibilitychange', focus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', focus)
      document.removeEventListener('visibilitychange', focus)
    }
  }, [chatId, connected, refresh])

  const loadOlder = useCallback(async () => {
    const current = stateRef.current
    if (!current?.next || loadingOlder) return
    const marker = generation.current
    wanted.current = current.pins.length + 1
    setLoadingOlder(true)
    try {
      await refresh()
    } finally {
      if (marker === generation.current) setLoadingOlder(false)
    }
  }, [loadingOlder, refresh])

  const pin = useCallback(
    async (message: Message, scope: PinScope) => {
      await sessionApi.pinMessage(message.chatId, message.id, scope)
      await refresh()
    },
    [refresh, sessionApi],
  )
  const unpin = useCallback(
    async (message: Message) => {
      setState((previous) =>
        previous && previous.chatId === message.chatId
          ? {
              ...previous,
              pins: previous.pins.filter((pin) => pin.message.id !== message.id),
              ids: previous.ids.filter((id) => id !== message.id),
              total: Math.max(0, previous.total - 1),
            }
          : previous,
      )
      try {
        await sessionApi.unpinMessage(message.chatId, message.id)
      } finally {
        await refresh()
      }
    },
    [refresh, sessionApi],
  )
  const unpinAll = useCallback(async () => {
    const id = chatRef.current
    if (!id) return
    await sessionApi.unpinAllMessages(id)
    setState((previous) =>
      previous?.chatId === id ? { ...previous, pins: [], ids: [], total: 0, next: null } : previous,
    )
    await refresh()
  }, [refresh, sessionApi])

  const onEvent = useCallback(
    (event: SocketEvent): boolean => {
      if (event.type === 'pins_changed') {
        if (event.chatId === chatRef.current) schedule()
        return true
      }
      if (
        (event.type === 'history_changed' ||
          event.type === 'message_changed' ||
          event.type === EventType.SUBSCRIBED) &&
        event.chatId === chatRef.current
      )
        schedule()
      return false
    },
    [schedule],
  )

  const visible = state && state.chatId === chatId ? state : null
  return {
    pins: visible?.pins ?? [],
    total: visible?.total ?? 0,
    hasOlder: Boolean(visible?.next),
    loadingOlder,
    pinnedIds: new Set(visible?.ids ?? []),
    loadOlder,
    pin,
    unpin,
    unpinAll,
    refresh,
    onEvent,
  }
}

export type MessagePins = ReturnType<typeof useMessagePins>
