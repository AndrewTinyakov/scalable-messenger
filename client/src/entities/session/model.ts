import type { components } from '../../shared/api/generated/schema'

export type User = components['schemas']['UserResponse']

export type Session = components['schemas']['AuthResponse']

const storageKey = 'messenger.session.v1'

export function readSession(): Session | null {
  try {
    const value = localStorage.getItem(storageKey)
    if (!value) return null
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object') return null
    const session = parsed as Partial<Session>
    if (typeof session.token !== 'string' || typeof session.deviceId !== 'string') return null
    if (!session.user || typeof session.user.id !== 'string' || typeof session.user.username !== 'string') return null
    return session as Session
  } catch {
    return null
  }
}

export function saveSession(session: Session | null) {
  if (session) localStorage.setItem(storageKey, JSON.stringify(session))
  else localStorage.removeItem(storageKey)
}
