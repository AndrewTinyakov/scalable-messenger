import { useCallback, useEffect, type Dispatch, type SetStateAction } from 'react'
import type { Chat } from '../entities/chat/model'
import type { ForwardSource, PendingSend } from '../entities/message/model'
import type { SavedSend, SendRequests } from '../entities/message/sendRequests'
import { isNetworkOnline } from '../shared/lib/network'

interface Options {
  pending: PendingSend[]
  requests: SendRequests
  catchUp(chatId: string): Promise<void>
  refreshChats(full?: boolean, invalidated?: boolean): Promise<Chat[]>
  setSelectedId: Dispatch<SetStateAction<string | null>>
  setDraftChat: Dispatch<SetStateAction<Chat | undefined>>
  setError(message: string | null): void
}
export function useMessengerSends({
  pending,
  requests,
  catchUp,
  refreshChats,
  setSelectedId,
  setDraftChat,
  setError,
}: Options) {
  const selectResolvedDraft = useCallback((saved: SavedSend) => {
    if (!saved.draftChatId) return false
    setSelectedId((current) => (current === saved.draftChatId ? saved.chatId : current))
    setDraftChat((current) =>
      current && current.id === saved.draftChatId ? { ...current, id: saved.chatId } : current,
    )
    return true
  }, [])

  const applySaved = useCallback(
    async (saved: SavedSend[]) => {
      if (saved.map(selectResolvedDraft).some(Boolean)) await refreshChats(false, true)
      for (const chatId of new Set(saved.map((result) => result.chatId))) await catchUp(chatId)
    },
    [catchUp, refreshChats, selectResolvedDraft],
  )

  const reconcilePending = useCallback(
    async (retryUnknown = false) => {
      if (!isNetworkOnline()) return
      await applySaved(await requests.reconcile(retryUnknown))
    },
    [applySaved, requests],
  )

  useEffect(() => {
    requests.resolved = (saved) => void applySaved(saved)
    return () => {
      requests.resolved = undefined
    }
  }, [applySaved, requests])

  useEffect(() => {
    if (
      !pending.some(
        (send) =>
          send.status === 'sending' || send.status === 'retryable' || send.status === 'queued',
      )
    )
      return
    let timer: number
    const poll = () => {
      void reconcilePending()
      timer = window.setTimeout(poll, (24 + Math.random() * 12) * 1000)
    }
    timer = window.setTimeout(poll, (24 + Math.random() * 12) * 1000)
    return () => window.clearTimeout(timer)
  }, [pending, reconcilePending])

  const sendMessage = useCallback(
    (chatId: string, body: string, replyToMessageId?: string, forward?: ForwardSource) => {
      const result = requests.start(chatId, body, replyToMessageId, forward)
      if (result.error) setError(result.error)
      else if (result.ok) setError(null)
      return result.ok
    },
    [requests],
  )

  const retryMessage = useCallback(
    async (requestId: string) => {
      try {
        const saved = await requests.retry(requestId)
        if (!saved) return
        if (selectResolvedDraft(saved)) await refreshChats(false, true)
        await catchUp(saved.chatId)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not check send status')
      }
    },
    [catchUp, refreshChats, requests, selectResolvedDraft],
  )

  return { selectResolvedDraft, reconcilePending, sendMessage, retryMessage }
}
