import { useEffect, type MutableRefObject } from 'react'
import type { Chat } from '../entities/chat/model'
import type { ChatRecovery } from '../entities/message/chatRecovery'
import { hasUnresolvedGap } from '../entities/message/historyWindow'
import type { SendRequests } from '../entities/message/sendRequests'

interface MessengerFocusOptions {
  recovery: ChatRecovery
  requests: SendRequests
  selectedRef: MutableRefObject<string | null>
  socketRef: MutableRefObject<WebSocket | null>
  activeRef: MutableRefObject<boolean>
  socketGenerationRef: MutableRefObject<number>
  focusRequestRef: MutableRefObject<Promise<void> | null>
  focusFreshAtRef: MutableRefObject<number>
  recoveryFailureRef: MutableRefObject<number>
  successfulRefreshes(): number
  refreshChats(full?: boolean, invalidated?: boolean): Promise<Chat[]>
  catchUp(chatId: string, fromStart?: boolean): Promise<void>
  reconcilePending(retryUnknown?: boolean): Promise<void>
}

export function useMessengerFocus({
  recovery,
  requests,
  selectedRef,
  socketRef,
  activeRef,
  socketGenerationRef,
  focusRequestRef,
  focusFreshAtRef,
  recoveryFailureRef,
  successfulRefreshes,
  refreshChats,
  catchUp,
  reconcilePending,
}: MessengerFocusOptions) {
  useEffect(() => {
    const onFocus = () => {
      if (focusRequestRef.current) return
      const chatId = selectedRef.current
      const needsRecovery =
        socketRef.current?.readyState !== WebSocket.OPEN ||
        Boolean(
          chatId &&
          (BigInt(recovery.latestSequences()[chatId] || '0') > BigInt(recovery.baseline(chatId)) ||
            hasUnresolvedGap(recovery.visibleWindows()[chatId] || [], recovery.baseline(chatId))),
        ) ||
        requests
          .list()
          .some(
            (send) =>
              send.status === 'sending' || send.status === 'retryable' || send.status === 'queued',
          )
      if (!needsRecovery && Date.now() - focusFreshAtRef.current < 5000) return
      focusFreshAtRef.current = 0
      const generation = socketGenerationRef.current
      const refreshSuccess = successfulRefreshes()
      const recoveryFailure = recoveryFailureRef.current
      const request = Promise.all([
        refreshChats(),
        chatId ? catchUp(chatId) : Promise.resolve(),
        reconcilePending(),
      ])
        .then(() => {
          if (
            activeRef.current &&
            generation === socketGenerationRef.current &&
            successfulRefreshes() > refreshSuccess &&
            recoveryFailureRef.current === recoveryFailure
          ) {
            focusFreshAtRef.current = Date.now()
          }
        })
        .finally(() => {
          if (focusRequestRef.current === request) focusRequestRef.current = null
        })
      focusRequestRef.current = request
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [catchUp, reconcilePending, recovery, refreshChats, requests, successfulRefreshes])
}
