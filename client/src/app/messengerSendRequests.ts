import type { MutableRefObject } from 'react'
import type { PendingSend } from '../entities/message/model'
import { SendRequests } from '../entities/message/sendRequests'
import { FrameType } from '../shared/api/generated/socket-vocabulary'
import type { api } from '../shared/api/http'
import { sendSocketFrame } from '../shared/api/socket'
import { createUlid } from '../shared/lib/id'

export function createMessengerSendRequests(
  prefix: string,
  sessionApi: ReturnType<typeof api.forSession>,
  socketRef: MutableRefObject<WebSocket | null>,
  setPending: (pending: PendingSend[]) => void,
): SendRequests {
  return new SendRequests(prefix, {
    storage: {
      getItem: (key) => localStorage.getItem(key),
      setItem: (key, value) => localStorage.setItem(key, value),
    },
    statuses: (ids) => sessionApi.sendStatuses(ids),
    status: (id) => sessionApi.sendStatus(id),
    send: (send) => {
      const socket = socketRef.current
      if (socket?.readyState !== WebSocket.OPEN) throw new Error('Socket disconnected')
      sendSocketFrame(socket, {
        type: FrameType.SEND,
        version: 1,
        ...(send.recipientId ? { recipientId: send.recipientId } : { chatId: send.chatId }),
        requestId: send.requestId,
        body: send.body,
        ...(send.replyToMessageId ? { replyToMessageId: send.replyToMessageId } : {}),
      })
    },
    isConnected: () => socketRef.current?.readyState === WebSocket.OPEN,
    createId: createUlid,
    now: Date.now,
    onChange: setPending,
  })
}
