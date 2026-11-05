import { useCallback, useEffect, useRef, useState } from 'react'
import type { Message } from '../../entities/message/model'
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
  next: string | null
}

const REFRESH_DELAY_MS = 250

export function useMessagePins(
  chatId: string | undefined,
  sessionApi: SessionApi,
  connected: boolean,
) {
  const [state, setState] = useState<PinsState | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const generation = useRef(0)
  const chatRef = useRef(chatId)
  chatRef.current = chatId
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const running = useRef<Promise<void> | null>(null)
  const again = useRef(false)

  const refresh = useCallback(async () => {
    const id = chatRef.current
    if (!id || id.startsWith('draft:')) return
    if (running.current) {
      again.current = true
      return running.current
    }
    const current = generation.current
    running.current = (async () => {
      try {
        do {
          again.current = false
          const page = await sessionApi.pinnedMessages(id)
          if (current !== generation.current) return
          setState({
            chatId: id,
            pins: page.pins,
            total: page.totalCount,
            next: page.nextBeforeSequence,
          })
        } while (again.current && current === generation.current)
      } catch {
      } finally {
        running.current = null
      }
    })()
    return running.current
  }, [sessionApi])

  const schedule = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void refresh(), REFRESH_DELAY_MS)
  }, [refresh])

  useEffect(() => {
    generation.current += 1
    running.current = null
    setState(null)
    setLoadingOlder(false)
    clearTimeout(timer.current)
    if (chatId && !chatId.startsWith('draft:') && connected) void refresh()
    return () => clearTimeout(timer.current)
  }, [chatId, connected, refresh])

  const loadOlder = useCallback(async () => {
    const current = state
    if (!current?.next || loadingOlder) return
    const marker = generation.current
    setLoadingOlder(true)
    try {
      const page = await sessionApi.pinnedMessages(current.chatId, current.next)
      if (marker !== generation.current) return
      setState((previous) =>
        previous && previous.chatId === current.chatId
          ? {
              ...previous,
              pins: [
                ...previous.pins,
                ...page.pins.filter(
                  (pin) => !previous.pins.some((item) => item.message.id === pin.message.id),
                ),
              ],
              total: page.totalCount,
              next: page.nextBeforeSequence,
            }
          : previous,
      )
    } finally {
      if (marker === generation.current) setLoadingOlder(false)
    }
  }, [loadingOlder, sessionApi, state])

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
      previous?.chatId === id ? { ...previous, pins: [], total: 0, next: null } : previous,
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
        (event.type === 'history_changed' || event.type === 'message_changed') &&
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
    pinnedIds: new Set(visible?.pins.map((pin) => pin.message.id) ?? []),
    loadOlder,
    pin,
    unpin,
    unpinAll,
    refresh,
    onEvent,
  }
}

export type MessagePins = ReturnType<typeof useMessagePins>
