import { useEffect, type MutableRefObject } from 'react'
import type { ChatRecovery } from '../entities/message/chatRecovery'

interface Options {
  recovery: ChatRecovery
  selectedId: string | null
  selectedRef: MutableRefObject<string | null>
  activeRef: MutableRefObject<boolean>
  focusRequestRef: MutableRefObject<Promise<void> | null>
}
export function useRecoveryLifecycle({
  recovery,
  selectedId,
  selectedRef,
  activeRef,
  focusRequestRef,
}: Options) {
  useEffect(() => {
    activeRef.current = true
    const flush = () => recovery.flush()
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      activeRef.current = false
      focusRequestRef.current = null
      recovery.dispose()
    }
  }, [recovery])

  useEffect(() => {
    selectedRef.current = selectedId
    recovery.onSelected(selectedId)
  }, [selectedId, recovery])

  useEffect(() => {
    let timer: number
    const renew = () => {
      const active = selectedRef.current
      if (active) recovery.renewGroup(active)
      timer = window.setTimeout(renew, (7 + Math.random()) * 60 * 1000)
    }
    timer = window.setTimeout(renew, (7 + Math.random()) * 60 * 1000)
    return () => window.clearTimeout(timer)
  }, [recovery])
}
