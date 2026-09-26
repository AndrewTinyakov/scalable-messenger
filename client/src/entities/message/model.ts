import type { components } from '../../shared/api/generated/schema'

export type Message = components['schemas']['MessageView']

export type SendState = 'sending' | 'retryable' | 'queued' | 'saved' | 'rejected'

export interface PendingSend {
  conversationId: string
  requestId: string
  body: string
  createdAt: string
  status: SendState
  reason?: string
  messageId?: string
}

const statusOrder: Record<SendState, number> = {
  sending: 0,
  retryable: 0,
  queued: 1,
  saved: 2,
  rejected: 2,
}

export function advanceSend(send: PendingSend, status: SendState, extra: Partial<PendingSend> = {}): PendingSend {
  if (statusOrder[status] < statusOrder[send.status]) return send
  if (statusOrder[status] === statusOrder[send.status] && status !== send.status && statusOrder[status] === 2) return send
  return { ...send, ...extra, status }
}

export function mergeMessages(current: Message[], incoming: Message[]): Message[] {
  const byId = new Map(current.map((message) => [message.id, message]))
  for (const message of incoming) byId.set(message.id, message)
  return [...byId.values()].sort((left, right) => {
    const leftSeq = BigInt(left.sequence)
    const rightSeq = BigInt(right.sequence)
    return leftSeq < rightSeq ? -1 : leftSeq > rightSeq ? 1 : 0
  })
}

export function highestSequence(messages: Message[]): string {
  return messages.reduce((highest, message) =>
    BigInt(message.sequence) > BigInt(highest) ? message.sequence : highest, '0')
}
