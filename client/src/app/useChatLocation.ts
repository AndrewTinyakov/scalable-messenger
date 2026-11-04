import { useCallback, useEffect, useState } from 'react'
import type { Chat } from '../entities/chat/model'
import { ChatKind } from '../shared/api/generated/socket-vocabulary'
import { isId } from '../shared/lib/validation'

export function chatPath(chat: Chat, userId: string): string {
  if (chat.kind === ChatKind.GROUP) return `/groups/${chat.id}`
  const recipient = chat.members.find((member) => member.id !== userId)
  return recipient ? `/users/${recipient.id}` : '/'
}

export function parseChatPath(path: string) {
  if (path === '/') return { kind: 'home' } as const
  const match = /^\/(users|groups)\/([^/]+)\/?$/.exec(path)
  if (!match || !isId(match[2])) return { kind: 'invalid' } as const
  return { kind: match[1] === 'users' ? 'direct' : 'group', id: match[2] } as const
}

export function useChatLocation() {
  const [path, setPath] = useState(() => window.location.pathname)
  const navigate = useCallback((next: string, replace = false) => {
    if (window.location.pathname !== next) {
      window.history[replace ? 'replaceState' : 'pushState'](null, '', next)
    }
    setPath(next)
  }, [])

  useEffect(() => {
    const pop = () => setPath(window.location.pathname)
    window.addEventListener('popstate', pop)
    return () => window.removeEventListener('popstate', pop)
  }, [])

  return { path, navigate }
}
