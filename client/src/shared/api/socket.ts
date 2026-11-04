import type { Message } from '../../entities/message/model'
import {
  isDateTime,
  isId,
  isRecord,
  isSendRejectionReason,
  isSequence,
  isStreamId,
} from '../lib/validation'
import { decodeMessage } from './decode'
import { EventType, FrameType, type ChatKind } from './generated/socket-vocabulary'

export type { ChatKind } from './generated/socket-vocabulary'

export function userRoom(userId: string): string {
  return `user:${userId}`
}
export function groupRoom(chatId: string): string {
  return `group:${chatId}`
}

export type RecoveryFrame =
  | { type: typeof FrameType.DISMISSED; version: 1; chatId: string; sequence: string }
  | {
      type: typeof FrameType.APPLIED
      version: 1
      chatId: string
      sequence: string
      epoch?: string
      streamId?: string
    }

type SendFrame = {
  type: typeof FrameType.SEND
  version: 1
  requestId: string
  body: string
  replyToMessageId?: string
} & ({ chatId: string; recipientId?: never } | { recipientId: string; chatId?: never })

type Subscription = {
  chatId: string
  kind: ChatKind
  epoch?: string
  streamId?: string
  lastAppliedSequence?: string
}

export type PresenceStatus = { userId: string; state: 'online' | 'offline' | 'unknown' }
export type OutgoingSocketFrame =
  | { type: 'watch_presence'; version: 1; chatId: string; userIds: string[] }
  | { type: 'unwatch_presence'; version: 1 }
  | SendFrame
  | RecoveryFrame
  | { type: typeof FrameType.SUBSCRIBE_MANY; version: 1; subscriptions: Subscription[] }
  | { type: typeof FrameType.UNSUBSCRIBE; version: 1; chatId: string }
  | { type: typeof FrameType.RECEIVED_MESSAGE; version: 1; chatId: string; sequence: string }

export function sendSocketFrame(socket: WebSocket, frame: OutgoingSocketFrame): void {
  const data = JSON.stringify(frame)
  if (socket.bufferedAmount + new TextEncoder().encode(data).byteLength > 1024 * 1024) {
    socket.close(4009, 'Outgoing queue is full')
    throw new Error('Connection is busy. Try again.')
  }
  socket.send(data)
}

type LiveEvent = { eventId: string; room: string; epoch: string; streamId: string }

type MessageFields = Omit<Message, 'id'> & { messageId: string }
export type SocketEvent = { version: 1 } & (
  | ({ type: 'message_changed'; mutationRevision: string } & MessageFields & LiveEvent)
  | ({ type: 'chat_deleted' | 'reads_changed'; chatId: string } & LiveEvent)
  | {
      type: 'presence'
      chatId: string
      observedAt: string
      validForMs: number
      statuses: PresenceStatus[]
    }
  | { type: typeof EventType.QUEUED; requestId: string; chatId?: string; recipientId?: string }
  | { type: typeof EventType.SUBSCRIBED; chatId: string; room: string }
  | ({ type: typeof EventType.CHAT_CREATED; chatId: string; requestId?: string } & LiveEvent)
  | ({
      type: typeof EventType.MESSAGE_SAVED
      chatId: string
      requestId: string
      messageId: string
      sequence: string
      senderId: string
      body: string
      createdAt: string
      messageVersion?: string
      replyToMessageId?: string | null
      replySenderId?: string | null
      replyBody?: string | null
      replyDeleted?: boolean | null
      replyVersion?: string | null
    } & LiveEvent)
  | ({
      type: typeof EventType.SEND_REJECTED
      requestId: string
      chatId?: string
      recipientId?: string
      reason: string
    } & LiveEvent)
  | { type: typeof EventType.ERROR; requestId?: string; code: string }
  | { type: typeof EventType.RECOVERY_FAILED; chatId: string; room?: string }
  | { type: typeof EventType.SUBSCRIPTION_EXPIRED; chatId: string }
  | ({ type: typeof EventType.MEMBER_REMOVED; chatId: string; memberId: string } & LiveEvent)
  | ({ type: typeof EventType.MEMBERSHIP_CHANGED; chatId: string } & LiveEvent)
)

const liveFields = ['eventId', 'room', 'epoch', 'streamId']
const messageFields = [
  'chatId',
  'messageId',
  'sequence',
  'senderId',
  'body',
  'createdAt',
  'messageVersion',
  'editedAt',
  'deletedAt',
  'replyToMessageId',
  'replySenderId',
  'replyBody',
  'replyDeleted',
  'replyVersion',
]
const eventFields = {
  message_changed: [...liveFields, ...messageFields, 'mutationRevision'],
  chat_deleted: [...liveFields, 'chatId'],
  reads_changed: [...liveFields, 'chatId'],
  presence: ['chatId', 'observedAt', 'validForMs', 'statuses'],
  [EventType.QUEUED]: ['requestId', 'chatId', 'recipientId'],
  [EventType.SUBSCRIBED]: ['chatId', 'room'],
  [EventType.CHAT_CREATED]: [...liveFields, 'chatId', 'requestId'],
  [EventType.MESSAGE_SAVED]: [
    ...liveFields,
    'chatId',
    'requestId',
    'messageId',
    'sequence',
    'senderId',
    'body',
    'createdAt',
    ...messageFields.filter((key) => key !== 'editedAt' && key !== 'deletedAt'),
  ],
  [EventType.SEND_REJECTED]: [...liveFields, 'requestId', 'chatId', 'recipientId', 'reason'],
  [EventType.ERROR]: ['requestId', 'code'],
  [EventType.RECOVERY_FAILED]: ['chatId', 'room'],
  [EventType.SUBSCRIPTION_EXPIRED]: ['chatId'],
  [EventType.MEMBER_REMOVED]: [...liveFields, 'chatId', 'memberId'],
  [EventType.MEMBERSHIP_CHANGED]: [...liveFields, 'chatId'],
} satisfies Record<SocketEvent['type'], readonly string[]>

function isRoom(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ((value.startsWith('user:') && isId(value.slice(5))) ||
      (value.startsWith('group:') && isId(value.slice(6))))
  )
}

export function decodeSocketEvent(data: unknown): SocketEvent | null {
  if (typeof data !== 'string' || data.length > 65536) return null
  let frame: unknown
  try {
    frame = JSON.parse(data)
  } catch {
    return null
  }
  if (!isRecord(frame) || frame.version !== 1) return null
  if (typeof frame.type !== 'string' || !Object.hasOwn(eventFields, frame.type)) return null
  const fields = eventFields[frame.type as SocketEvent['type']]
  if (
    Object.keys(frame).some((key) => key !== 'type' && key !== 'version' && !fields.includes(key))
  )
    return null
  for (const key of [
    'chatId',
    'recipientId',
    'requestId',
    'messageId',
    'senderId',
    'memberId',
    'eventId',
  ]) {
    if (key in frame && !isId(frame[key])) return null
  }
  if ('room' in frame && !isRoom(frame.room)) return null
  const live =
    isId(frame.eventId) &&
    isRoom(frame.room) &&
    typeof frame.epoch === 'string' &&
    frame.epoch.length > 0 &&
    isStreamId(frame.streamId)
  let valid = false
  switch (frame.type) {
    case 'presence':
      valid =
        isId(frame.chatId) &&
        isDateTime(frame.observedAt) &&
        typeof frame.validForMs === 'number' &&
        Number.isSafeInteger(frame.validForMs) &&
        frame.validForMs > 0 &&
        frame.validForMs <= 30000 &&
        Array.isArray(frame.statuses) &&
        frame.statuses.length <= 100 &&
        frame.statuses.every(
          (status) =>
            isRecord(status) &&
            Object.keys(status).every((key) => ['userId', 'state'].includes(key)) &&
            isId(status.userId) &&
            ['online', 'offline', 'unknown'].includes(String(status.state)),
        ) &&
        new Set(frame.statuses.map((status) => (status as PresenceStatus).userId)).size ===
          frame.statuses.length
      break
    case 'chat_deleted':
    case 'reads_changed':
      valid = live && isId(frame.chatId)
      break
    case 'message_changed':
      if (
        !live ||
        !isId(frame.messageId) ||
        !isSequence(frame.mutationRevision) ||
        frame.mutationRevision === '0' ||
        !isSequence(frame.messageVersion) ||
        frame.messageVersion === '0'
      )
        break
      try {
        decodeMessage(
          Object.fromEntries([
            ['id', frame.messageId],
            ...messageFields
              .filter((key) => key !== 'messageId' && key in frame)
              .map((key) => [key, frame[key]]),
          ]),
          String(frame.chatId),
        )
        valid = messageFields.every((key) => !(key in frame) || frame[key] != null)
      } catch {
        valid = false
      }
      break
    case EventType.QUEUED:
      valid = isId(frame.requestId) && isId(frame.chatId) !== isId(frame.recipientId)
      break
    case EventType.SUBSCRIBED:
      valid = isId(frame.chatId) && isRoom(frame.room)
      break
    case EventType.CHAT_CREATED:
      valid =
        live &&
        isId(frame.chatId) &&
        typeof frame.room === 'string' &&
        frame.room.startsWith('user:')
      break
    case EventType.MEMBER_REMOVED:
      valid =
        live &&
        isId(frame.chatId) &&
        isId(frame.memberId) &&
        (frame.room === userRoom(frame.memberId) || frame.room === groupRoom(frame.chatId))
      break
    case EventType.MEMBERSHIP_CHANGED:
      valid = live && isId(frame.chatId) && frame.room === groupRoom(frame.chatId)
      break
    case EventType.MESSAGE_SAVED:
      try {
        decodeMessage(
          Object.fromEntries([
            ['id', frame.messageId],
            ...messageFields
              .filter((key) => key !== 'messageId' && key in frame)
              .map((key) => [key, frame[key]]),
          ]),
          String(frame.chatId),
        )
        valid =
          live &&
          isId(frame.requestId) &&
          messageFields.every((key) => !(key in frame) || frame[key] != null)
      } catch {
        valid = false
      }
      break
    case EventType.SEND_REJECTED:
      valid =
        live &&
        isId(frame.requestId) &&
        isId(frame.chatId) !== isId(frame.recipientId) &&
        isSendRejectionReason(frame.reason)
      break
    case EventType.ERROR:
      valid = typeof frame.code === 'string' && frame.code.length > 0
      break
    case EventType.RECOVERY_FAILED:
    case EventType.SUBSCRIPTION_EXPIRED:
      valid = isId(frame.chatId)
      break
  }
  return valid ? (frame as SocketEvent) : null
}
