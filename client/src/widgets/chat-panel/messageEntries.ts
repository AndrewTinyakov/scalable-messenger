import type { Message, PendingSend } from '../../entities/message/model'

export function messageEntries(
  chatId: string,
  recipientId: string | undefined,
  messages: Message[],
  pending: PendingSend[],
  hasNewer: boolean,
) {
  const sends = pending.filter(
    (send) => send.chatId === chatId || (recipientId && send.recipientId === recipientId),
  )
  const sendsByMessage = new Map(
    sends.filter((send) => send.messageId).map((send) => [send.messageId, send]),
  )
  const unsaved = hasNewer
    ? []
    : sends.filter(
        (send) =>
          !messages.some((message) => message.id === send.messageId) &&
          (send.status !== 'saved' ||
            !send.sequence ||
            BigInt(send.sequence) > BigInt(messages.at(-1)?.sequence || '0')),
      )
  return [
    ...messages.map((message) => ({
      key: sendsByMessage.get(message.id)?.requestId ?? message.id,
      message,
      send: sendsByMessage.get(message.id),
    })),
    ...unsaved
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((send) => ({ key: send.requestId, message: undefined as Message | undefined, send })),
  ]
}
