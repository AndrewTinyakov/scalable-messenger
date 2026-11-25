import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from 'react'
import { PresenceStore, type PresenceSource } from './presenceStore'

export const PresenceContext = createContext<PresenceStore>(new PresenceStore())

/** Watches users for one part of the UI while it is mounted. */
export function usePresence(source: PresenceSource, ids: readonly string[]) {
  const store = useContext(PresenceContext)
  const consumer = useRef({}).current
  const key = ids.join(',')
  useEffect(() => {
    store.watch(source, consumer, key ? key.split(',') : [])
    return () => store.watch(source, consumer, [])
  }, [store, source, consumer, key])
  return useSyncExternalStore(store.subscribe, store.getSnapshot).statuses
}

/** Follows the online count of a small group while it is shown. */
export function useOnlineCount(chatId: string | undefined, members: number) {
  const store = useContext(PresenceContext)
  useEffect(() => {
    store.watchOnlineCount(chatId, members)
    return () => store.watchOnlineCount(undefined)
  }, [store, chatId, members])
  const counts = useSyncExternalStore(store.subscribe, store.getSnapshot).onlineCounts
  const count = chatId ? counts.get(chatId) : undefined
  return count?.members === members ? count : undefined
}

/** Reads statuses that another part of the UI already watches. */
export function usePresenceStatuses() {
  const store = useContext(PresenceContext)
  return useSyncExternalStore(store.subscribe, store.getSnapshot).statuses
}
