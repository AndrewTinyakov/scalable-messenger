import { useCallback, useRef, useState } from 'react'
import type { ChatRecovery } from '../entities/message/chatRecovery'
import { isWaitingFailure } from '../shared/api/http'

export function useChatHistory(recovery: ChatRecovery, setError: (message: string | null) => void) {
  const [loadingOlder, setLoadingOlder] = useState<string | null>(null)
  const [loadingNewer, setLoadingNewer] = useState<string | null>(null)
  const readingHistoryRef = useRef(new Set<string>())

  const showLatest = useCallback(
    async (chatId: string) => {
      try {
        await recovery.showLatest(chatId)
        readingHistoryRef.current.delete(chatId)
      } catch (cause) {
        if (isWaitingFailure(cause)) return
        setError(cause instanceof Error ? cause.message : 'Could not load chat history')
      }
    },
    [recovery, setError],
  )

  const loadOlder = useCallback(
    async (chatId: string) => {
      setLoadingOlder(chatId)
      try {
        await recovery.loadOlder(chatId)
      } catch (cause) {
        if (isWaitingFailure(cause)) return
        setError(cause instanceof Error ? cause.message : 'Could not load older messages')
      } finally {
        setLoadingOlder(null)
      }
    },
    [recovery, setError],
  )

  const loadNewer = useCallback(
    async (chatId: string) => {
      setLoadingNewer(chatId)
      try {
        await recovery.loadNewer(chatId)
      } catch (cause) {
        if (isWaitingFailure(cause)) return
        setError(cause instanceof Error ? cause.message : 'Could not load newer messages')
      } finally {
        setLoadingNewer(null)
      }
    },
    [recovery, setError],
  )

  const setAtLatestPosition = useCallback((chatId: string, atLatest: boolean) => {
    if (atLatest) readingHistoryRef.current.delete(chatId)
    else readingHistoryRef.current.add(chatId)
  }, [])

  const isReadingHistory = useCallback(
    (chatId: string) => readingHistoryRef.current.has(chatId),
    [],
  )
  const leaveHistory = useCallback((chatId: string) => {
    readingHistoryRef.current.delete(chatId)
  }, [])

  return {
    loadingOlder,
    loadingNewer,
    showLatest,
    loadOlder,
    loadNewer,
    setAtLatestPosition,
    isReadingHistory,
    leaveHistory,
  }
}
