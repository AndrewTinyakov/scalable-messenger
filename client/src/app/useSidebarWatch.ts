import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Chat } from '../entities/chat/model'
import { ChatKind } from '../shared/api/generated/socket-vocabulary'
import type { OutgoingSocketFrame, PresenceStatus, SocketEvent } from '../shared/api/socket'
import { isId } from '../shared/lib/validation'

interface Options {
  connectionGeneration: number
  connected: boolean
  userId: string
  selectedChat?: Chat
  listChats(): Chat[]
  send(frame: OutgoingSocketFrame): void
}

export function useSidebarWatch(options: Options) {
  const current = useRef(options)
  current.current = options
  const [visible, setVisible] = useState<string[]>([])
  const [presence, setPresence] = useState<Record<string, PresenceStatus['state']>>({})
  const peers = useRef(new Set<string>())
  const observedAt = useRef(0)
  const expiry = useRef<ReturnType<typeof setTimeout>>()
  const watchSidebarPeers = useCallback((chatIds: string[]) => setVisible(chatIds), [])
  const selected = options.selectedChat?.id
  const key = useMemo(
    () =>
      [...new Set([...(selected ? [selected] : []), ...visible].filter(isId))]
        .slice(0, 100)
        .sort()
        .join(','),
    [selected, visible],
  )
  const watchedIds = new Set(key ? key.split(',') : [])
  const peerKey = [
    ...new Set(
      [...options.listChats(), ...(options.selectedChat ? [options.selectedChat] : [])]
        .filter((chat) => watchedIds.has(chat.id) && chat.kind === ChatKind.DIRECT)
        .flatMap((chat) => chat.members.map((member) => member.id))
        .filter((id) => id !== options.userId),
    ),
  ]
    .sort()
    .join(',')
  const validUntil = useRef(0)
  const lastGeneration = useRef<number | null>(null)
  useEffect(() => {
    clearTimeout(expiry.current)
    const keep =
      options.connected &&
      lastGeneration.current === options.connectionGeneration &&
      validUntil.current > Date.now()
    lastGeneration.current = options.connected ? options.connectionGeneration : null
    if (!keep) {
      observedAt.current = 0
      validUntil.current = 0
    }
    peers.current = new Set(peerKey ? peerKey.split(',') : [])
    const ids = key ? key.split(',') : []
    const unknown = () =>
      Object.fromEntries([...peers.current].map((id) => [id, 'unknown' as const]))
    setPresence((previous) =>
      keep
        ? Object.fromEntries([...peers.current].map((id) => [id, previous[id] ?? 'unknown']))
        : unknown(),
    )
    if (keep)
      expiry.current = setTimeout(() => setPresence(unknown()), validUntil.current - Date.now())
    if (!options.connected) return
    const send = () => current.current.send({ type: 'watch_sidebar', version: 1, chatIds: ids })
    const debounce = setTimeout(send, 250)
    const renewal = setInterval(send, 20000 + Math.random() * 3000)
    return () => {
      clearTimeout(debounce)
      clearInterval(renewal)
      clearTimeout(expiry.current)
    }
  }, [key, peerKey, options.connected, options.connectionGeneration])
  const onEvent = useCallback((event: SocketEvent): boolean => {
    if (event.type !== 'sidebar_presence') return false
    if (!current.current.connected) return true
    const at = Date.parse(event.observedAt)
    const remaining = at + event.validForMs - Date.now()
    if (at < observedAt.current || at > Date.now() + 30000 || remaining <= 0) return true
    observedAt.current = at
    validUntil.current = at + event.validForMs
    clearTimeout(expiry.current)
    const next: Record<string, PresenceStatus['state']> = Object.fromEntries(
      [...peers.current].map((id) => [id, 'unknown']),
    )
    for (const status of event.statuses)
      if (peers.current.has(status.userId)) next[status.userId] = status.state
    setPresence(next)
    expiry.current = setTimeout(
      () => setPresence(Object.fromEntries([...peers.current].map((id) => [id, 'unknown']))),
      remaining,
    )
    return true
  }, [])
  return {
    sidebarPresence: options.connected
      ? presence
      : Object.fromEntries([...peers.current].map((id) => [id, 'unknown' as const])),
    watchSidebarPeers,
    onEvent,
  }
}
