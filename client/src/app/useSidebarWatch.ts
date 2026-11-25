import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Chat } from '../entities/chat/model'
import type { PresenceStore } from '../features/presence/presenceStore'
import { ChatKind } from '../shared/api/generated/socket-vocabulary'
import type { OutgoingSocketFrame } from '../shared/api/socket'
import { isId } from '../shared/lib/validation'

interface Options {
  connectionGeneration: number
  connected: boolean
  userId: string
  selectedChat?: Chat
  presence: PresenceStore
  listChats(): Chat[]
  send(frame: OutgoingSocketFrame): void
}

/**
 * Follows group activity for visible rows and the presence of every loaded
 * direct chat, visible rows first.
 */
export function useSidebarWatch(options: Options) {
  const current = useRef(options)
  current.current = options
  const [visible, setVisible] = useState<string[]>([])
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
  useEffect(() => {
    if (!options.connected) return
    const ids = key ? key.split(',') : []
    const send = () => current.current.send({ type: 'watch_sidebar', version: 1, chatIds: ids })
    const debounce = setTimeout(send, 250)
    const renewal = setInterval(send, 20000 + Math.random() * 3000)
    return () => {
      clearTimeout(debounce)
      clearInterval(renewal)
    }
  }, [key, options.connected, options.connectionGeneration])
  const visibleSet = new Set(visible)
  const loaded = options.listChats()
  const peers = [
    ...loaded.filter((chat) => visibleSet.has(chat.id)),
    ...loaded.filter((chat) => !visibleSet.has(chat.id)),
  ]
    .filter((chat) => chat.kind === ChatKind.DIRECT)
    .flatMap((chat) => chat.members.map((member) => member.id))
    .filter((id) => id !== options.userId && isId(id))
  const peerKey = [...new Set(peers)].join(',')
  const consumer = useRef({}).current
  useEffect(() => {
    options.presence.watch('sidebar', consumer, peerKey ? peerKey.split(',') : [])
  }, [options.presence, consumer, peerKey])
  useEffect(
    () => () => options.presence.watch('sidebar', consumer, []),
    [options.presence, consumer],
  )
  return { watchSidebarPeers }
}
