import type { components } from '../../shared/api/generated/schema'

type WireMessage = components['schemas']['MessageResponse']
type MessageIdentity = 'id' | 'chatId' | 'sequence' | 'senderId' | 'body' | 'createdAt'
export type Message = Pick<WireMessage, MessageIdentity> &
  Partial<Omit<WireMessage, MessageIdentity>>

export type SendState = 'sending' | 'retryable' | 'queued' | 'saved' | 'rejected'

export interface PendingSend {
  chatId: string
  recipientId?: string
  replyToMessageId?: string
  requestId: string
  body: string
  createdAt: string
  status: SendState
  reason?: string
  messageId?: string
  sequence?: string
}

const statusOrder: Record<SendState, number> = {
  sending: 0,
  retryable: 0,
  queued: 1,
  saved: 2,
  rejected: 2,
}

export function advanceSend(
  send: PendingSend,
  status: SendState,
  extra: Partial<PendingSend> = {},
): PendingSend {
  if (statusOrder[status] < statusOrder[send.status]) return send
  if (
    statusOrder[status] === statusOrder[send.status] &&
    status !== send.status &&
    statusOrder[status] === 2
  )
    return send
  return { ...send, ...extra, status }
}

export function mergeMessages(current: Message[], incoming: Message[]): Message[] {
  const byId = new Map(current.map((message) => [message.id, message]))
  for (const message of incoming) {
    const previous = byId.get(message.id)
    const next =
      !previous ||
      BigInt(message.messageVersion ?? '1') > BigInt(previous.messageVersion ?? '1') ||
      (BigInt(message.messageVersion ?? '1') === BigInt(previous.messageVersion ?? '1') &&
        !previous.deletedAt)
        ? message
        : previous
    const preview =
      previous &&
      message.replySenderId != null &&
      BigInt(previous.replyVersion ?? '0') > BigInt(message.replyVersion ?? '0')
        ? previous
        : message
    byId.set(
      message.id,
      next.deletedAt
        ? {
            ...next,
            replyToMessageId: null,
            replySenderId: null,
            replyBody: null,
            replyDeleted: null,
            replyVersion: null,
          }
        : next.replyToMessageId && preview.replyToMessageId === next.replyToMessageId
          ? {
              ...next,
              replySenderId: preview.replySenderId,
              replyBody: preview.replyBody,
              replyDeleted: preview.replyDeleted,
              replyVersion: preview.replyVersion,
            }
          : next,
    )
  }
  for (const [id, message] of byId) {
    const target = message.replyToMessageId ? byId.get(message.replyToMessageId) : undefined
    if (
      target &&
      message.replyVersion != null &&
      BigInt(target.messageVersion ?? '1') >= BigInt(message.replyVersion)
    )
      byId.set(id, {
        ...message,
        replySenderId: target.senderId,
        replyBody: target.deletedAt ? '' : [...target.body].slice(0, 160).join(''),
        replyDeleted: Boolean(target.deletedAt),
        replyVersion: target.messageVersion ?? '1',
      })
  }
  return [...byId.values()].sort((left, right) => {
    const leftSeq = BigInt(left.sequence)
    const rightSeq = BigInt(right.sequence)
    return leftSeq < rightSeq ? -1 : leftSeq > rightSeq ? 1 : 0
  })
}

export function highestSequence(messages: Message[]): string {
  return messages.reduce(
    (highest, message) => (BigInt(message.sequence) > BigInt(highest) ? message.sequence : highest),
    '0',
  )
}
