import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from 'react'
import { PresenceStore, type PresenceSource } from './presenceStore'

export const PresenceContext = createContext<PresenceStore>(new PresenceStore())

export function useWatch(store: PresenceStore, source: PresenceSource, ids: readonly string[]) {
  const consumer = useRef({}).current
  const key = ids.join(',')
  useEffect(() => {
    store.watch(source, consumer, key ? key.split(',') : [])
    return () => store.watch(source, consumer, [])
  }, [store, source, consumer, key])
}

export function usePresence(source: PresenceSource, ids: readonly string[]) {
  const store = useContext(PresenceContext)
  useWatch(store, source, ids)
  return useSyncExternalStore(store.subscribe, store.getSnapshot).statuses
}

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

export function usePresenceStatuses() {
  const store = useContext(PresenceContext)
  return useSyncExternalStore(store.subscribe, store.getSnapshot).statuses
}
