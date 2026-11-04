import { useCallback, useEffect, useRef, useState } from 'react'
import type { Chat } from '../entities/chat/model'
import { ChatKind } from '../shared/api/generated/socket-vocabulary'
import type { OutgoingSocketFrame, PresenceStatus, SocketEvent } from '../shared/api/socket'
import { isId } from '../shared/lib/validation'

interface Options {
  connectionGeneration: number
  connected: boolean
  userId: string
  listChats(): Chat[]
  send(frame: OutgoingSocketFrame): void
}

export function useSidebarWatch(options: Options) {
  const current = useRef(options)
  current.current = options
  const [key, setKey] = useState('')
  const [presence, setPresence] = useState<Record<string, PresenceStatus['state']>>({})
  const peers = useRef(new Set<string>())
  const observedAt = useRef(0)
  const expiry = useRef<ReturnType<typeof setTimeout>>()
  const watchSidebarPeers = useCallback((chatIds: string[]) => {
    setKey([...new Set(chatIds.filter(isId))].slice(0, 100).sort().join(','))
  }, [])
  useEffect(() => {
    clearTimeout(expiry.current)
    observedAt.current = 0
    peers.current = new Set()
    const ids = key ? key.split(',') : []
    const watched = new Set(ids)
    for (const chat of current.current.listChats()) {
      if (watched.has(chat.id) && chat.kind === ChatKind.DIRECT)
        for (const member of chat.members)
          if (member.id !== current.current.userId) peers.current.add(member.id)
    }
    setPresence(Object.fromEntries([...peers.current].map((id) => [id, 'unknown'])))
    if (!options.connected) return
    const send = () => current.current.send({ type: 'watch_sidebar', version: 1, chatIds: ids })
    const debounce = setTimeout(send, 250)
    const renewal = setInterval(send, 20000 + Math.random() * 3000)
    return () => {
      clearTimeout(debounce)
      clearInterval(renewal)
      clearTimeout(expiry.current)
    }
  }, [key, options.connected, options.connectionGeneration])
  const onEvent = useCallback((event: SocketEvent): boolean => {
    if (event.type !== 'sidebar_presence') return false
    if (!current.current.connected) return true
    const at = Date.parse(event.observedAt)
    const remaining = at + event.validForMs - Date.now()
    if (at < observedAt.current || at > Date.now() + 30000 || remaining <= 0) return true
    observedAt.current = at
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
