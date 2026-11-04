import { useEffect, useRef, useState } from 'react'
import type { Chat } from '../../entities/chat/model'
import type { Message } from '../../entities/message/model'
import type { User } from '../../entities/session/model'
import { ChatKind } from '../../shared/api/generated/socket-vocabulary'

export function useSenderNames(
  chat: Chat | undefined,
  messages: Message[],
  lookup?: (id: string) => Promise<User>,
) {
  const cache = useRef(new Map<string, string>())
  const requested = useRef(new Set<string>())
  const queue = useRef<string[]>([])
  const running = useRef(false)
  const active = useRef(true)
  const [names, setNames] = useState(new Map<string, string>())
  const senderIds =
    chat?.kind === ChatKind.GROUP
      ? [
          ...new Set(
            messages.flatMap((message) => [
              message.senderId,
              ...(message.replySenderId ? [message.replySenderId] : []),
            ]),
          ),
        ]
          .sort()
          .join(',')
      : ''

  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])

  useEffect(() => {
    const wanted = new Set([
      ...(chat?.members ?? []).map((member) => member.id),
      ...(senderIds ? senderIds.split(',') : []),
    ])
    for (const id of cache.current.keys()) if (!wanted.has(id)) cache.current.delete(id)
    for (const id of requested.current) if (!wanted.has(id)) requested.current.delete(id)
    queue.current = queue.current.filter((id) => wanted.has(id))
    let changed = false
    for (const member of chat?.members ?? []) {
      if (cache.current.get(member.id) === member.username) continue
      cache.current.set(member.id, member.username)
      changed = true
    }
    if (changed) setNames(new Map(cache.current))
    if (!lookup || !senderIds) return
    for (const id of senderIds.split(',')) {
      if (cache.current.has(id) || requested.current.has(id)) continue
      requested.current.add(id)
      queue.current.push(id)
    }
    if (running.current) return
    running.current = true
    void (async () => {
      try {
        while (active.current && queue.current.length) {
          const id = queue.current.shift()!
          try {
            const user = await lookup(id)
            if (!active.current) return
            if (cache.current.size >= 400) cache.current.delete(cache.current.keys().next().value!)
            cache.current.set(id, user.username)
            setNames(new Map(cache.current))
          } catch {
            requested.current.delete(id)
          }
        }
      } finally {
        running.current = false
      }
    })()
  }, [chat?.members, lookup, senderIds])

  return new Map([
    ...names,
    ...(chat?.members ?? []).map((member) => [member.id, member.username] as const),
  ])
}
