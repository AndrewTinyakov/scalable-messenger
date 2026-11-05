import { useCallback, useSyncExternalStore } from 'react'

export interface NotificationSettings {
  desktop: boolean
  sound: boolean
}

const KEY = 'relay.notifications'
const DEFAULTS: NotificationSettings = { desktop: true, sound: true }
const listeners = new Set<() => void>()
let cached: NotificationSettings | null = null

function read(): NotificationSettings {
  if (cached) return cached
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    cached =
      stored && typeof stored === 'object'
        ? {
            desktop: (stored as Partial<NotificationSettings>).desktop !== false,
            sound: (stored as Partial<NotificationSettings>).sound !== false,
          }
        : DEFAULTS
  } catch {
    cached = DEFAULTS
  }
  return cached
}

function write(next: NotificationSettings) {
  cached = next
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {}
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  const storage = (event: StorageEvent) => {
    if (event.key !== KEY) return
    cached = null
    listener()
  }
  window.addEventListener('storage', storage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', storage)
  }
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
}

export function useNotificationSettings() {
  const settings = useSyncExternalStore(subscribe, read, () => DEFAULTS)
  const update = useCallback(async (change: Partial<NotificationSettings>) => {
    const next = { ...read(), ...change }
    if (change.desktop && notificationPermission() === 'default') {
      try {
        await Notification.requestPermission()
      } catch {}
    }
    write(next)
  }, [])
  return { settings, update }
}

export function currentNotificationSettings(): NotificationSettings {
  return read()
}
