import type { Chat } from '../../entities/chat/model'
import type { Session, User } from '../../entities/session/model'
import { isDateTime, isId, isRecord, isSendRejectionReason, isSequence } from '../lib/validation'
import type { components } from './generated/schema'
import { ChatKind } from './generated/socket-vocabulary'

function invalid(): never {
  throw new Error('Invalid response from server')
}

function fields(
  value: unknown,
  required: string[],
  optional: string[] = [],
): asserts value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  )
    invalid()
}

function optionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string'
}

export function decodeUser(value: unknown): User {
  fields(value, ['id', 'username'])
  if (
    !isId(value.id) ||
    typeof value.username !== 'string' ||
    !value.username ||
    value.username.length > 40
  )
    invalid()
  return value as User
}

export function decodeSession(value: unknown): Session {
  fields(value, ['user', 'deviceId'])
  if (typeof value.deviceId !== 'string' || !value.deviceId || value.deviceId.length > 64) invalid()
  decodeUser(value.user)
  return value as Session
}

export function decodeSessionStatus(value: unknown): components['schemas']['SessionResponse'] {
  fields(value, ['userId', 'username', 'deviceId'])
  if (
    !isId(value.userId) ||
    typeof value.username !== 'string' ||
    !value.username ||
    value.username.length > 40 ||
    typeof value.deviceId !== 'string' ||
    !value.deviceId ||
    value.deviceId.length > 64
  )
    invalid()
  return value as components['schemas']['SessionResponse']
}

export function decodeTicket(value: unknown): components['schemas']['WsTicketResponse'] {
  fields(value, ['token', 'expiresAt'])
  if (
    typeof value.token !== 'string' ||
    value.token.length > 4096 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.token) ||
    typeof value.expiresAt !== 'number' ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= 0
  )
    invalid()
  return value as components['schemas']['WsTicketResponse']
}

export function decodeUsers(value: unknown): User[] {
  if (!Array.isArray(value)) invalid()
  return value.map(decodeUser)
}

export function decodeChat(value: unknown): Chat {
  fields(value, ['id', 'kind', 'members', 'memberCount', 'lastSequence'], ['name', 'ownerId'])
  if (
    !isId(value.id) ||
    (value.kind !== ChatKind.DIRECT && value.kind !== ChatKind.GROUP) ||
    !optionalString(value.name) ||
    (value.ownerId != null && !isId(value.ownerId)) ||
    !Array.isArray(value.members) ||
    typeof value.memberCount !== 'number' ||
    !Number.isSafeInteger(value.memberCount) ||
    value.memberCount < 1 ||
    !isSequence(value.lastSequence)
  )
    invalid()
  value.members.forEach(decodeUser)
  return value as Chat
}

export function decodeGroupMembers(
  value: unknown,
): components['schemas']['GroupMemberPageResponse'] {
  fields(value, ['members', 'nextCursor'])
  if (!Array.isArray(value.members) || (value.nextCursor != null && !isId(value.nextCursor)))
    invalid()
  value.members.forEach(decodeUser)
  return value as components['schemas']['GroupMemberPageResponse']
}

export function decodeChats(value: unknown): { chats: Chat[]; nextCursor: string | null } {
  fields(value, ['chats'], ['nextCursor'])
  if (
    !Array.isArray(value.chats) ||
    (value.nextCursor != null &&
      (typeof value.nextCursor !== 'string' ||
        value.nextCursor.length > 256 ||
        !/^[A-Za-z0-9_-]+$/.test(value.nextCursor)))
  )
    invalid()
  return {
    chats: value.chats.map(decodeChat),
    nextCursor: typeof value.nextCursor === 'string' ? value.nextCursor : null,
  }
}

export function decodeDirectChat(
  value: unknown,
  recipientId: string,
  userId: string,
): components['schemas']['DirectChatResponse'] {
  fields(value, ['recipient', 'chat'])
  const recipient = decodeUser(value.recipient)
  if (recipient.id !== recipientId || recipient.id === userId) invalid()
  if (value.chat !== null) {
    const chat = decodeChat(value.chat)
    if (
      chat.kind !== ChatKind.DIRECT ||
      !chat.members.some((member) => member.id === recipientId) ||
      !chat.members.some((member) => member.id === userId)
    )
      invalid()
  }
  return value as components['schemas']['DirectChatResponse']
}

export function decodeMessage(
  value: unknown,
  chatId: string,
): components['schemas']['MessageResponse'] {
  fields(
    value,
    ['id', 'chatId', 'sequence', 'senderId', 'body', 'createdAt'],
    [
      'messageVersion',
      'editedAt',
      'deletedAt',
      'replyToMessageId',
      'replySenderId',
      'replyBody',
      'replyDeleted',
      'replyVersion',
    ],
  )
  if (
    !isId(value.id) ||
    value.chatId !== chatId ||
    !isSequence(value.sequence) ||
    value.sequence === '0' ||
    !isId(value.senderId) ||
    typeof value.body !== 'string' ||
    (!value.body && value.deletedAt == null) ||
    [...value.body].length > 4000 ||
    !isDateTime(value.createdAt)
  )
    invalid()
  if (
    value.messageVersion !== undefined &&
    (!isSequence(value.messageVersion) || value.messageVersion === '0')
  )
    invalid()
  for (const key of ['editedAt', 'deletedAt'])
    if (value[key] != null && !isDateTime(value[key])) invalid()
  if (value.deletedAt != null && value.body !== '') invalid()
  if (value.replyToMessageId != null) {
    if (
      !isId(value.replyToMessageId) ||
      !isId(value.replySenderId) ||
      typeof value.replyBody !== 'string' ||
      [...value.replyBody].length > 160 ||
      typeof value.replyDeleted !== 'boolean' ||
      !isSequence(value.replyVersion) ||
      value.replyVersion === '0' ||
      (!value.replyDeleted && value.replyBody === '') ||
      (value.replyDeleted && value.replyBody !== '')
    )
      invalid()
  } else if (
    ['replySenderId', 'replyBody', 'replyDeleted', 'replyVersion'].some((key) => value[key] != null)
  )
    invalid()
  return {
    messageVersion: '1',
    editedAt: null,
    deletedAt: null,
    replyToMessageId: null,
    replySenderId: null,
    replyBody: null,
    replyDeleted: null,
    replyVersion: null,
    ...value,
  } as components['schemas']['MessageResponse']
}

export function decodeHistory(
  value: unknown,
  chatId: string,
): components['schemas']['MessageHistoryResponse'] {
  fields(value, ['messages', 'nextSequence', 'hasMore'], ['mutationRevision'])
  if (
    !Array.isArray(value.messages) ||
    !isSequence(value.nextSequence) ||
    typeof value.hasMore !== 'boolean'
  )
    invalid()
  if (value.mutationRevision != null && !isSequence(value.mutationRevision)) invalid()
  return {
    ...value,
    messages: value.messages.map((message) => decodeMessage(message, chatId)),
    mutationRevision: value.mutationRevision ?? '0',
  } as components['schemas']['MessageHistoryResponse']
}

export type DecodedSendStatus = components['schemas']['SendStatusResponse']

export function decodeSendStatus(value: unknown): DecodedSendStatus {
  fields(value, ['status'], ['chatId', 'messageId', 'sequence', 'reason'])
  if (value.status !== 'UNKNOWN' && value.status !== 'SAVED' && value.status !== 'REJECTED')
    invalid()
  if (value.chatId != null && !isId(value.chatId)) invalid()
  if (value.messageId != null && !isId(value.messageId)) invalid()
  if (value.sequence != null && (!isSequence(value.sequence) || value.sequence === '0')) invalid()
  if (
    value.status === 'SAVED' &&
    (!isId(value.chatId) ||
      !isId(value.messageId) ||
      !isSequence(value.sequence) ||
      value.sequence === '0' ||
      value.reason != null)
  )
    invalid()
  if (
    value.status === 'REJECTED' &&
    (!isSendRejectionReason(value.reason) || value.messageId != null || value.sequence != null)
  )
    invalid()
  if (
    value.status === 'UNKNOWN' &&
    [value.chatId, value.messageId, value.sequence, value.reason].some((field) => field != null)
  )
    invalid()
  return value as DecodedSendStatus
}

export function decodeSendStatuses(value: unknown): {
  results: { requestId: string; result: DecodedSendStatus }[]
} {
  fields(value, ['results'])
  if (!Array.isArray(value.results)) invalid()
  return {
    results: value.results.map((entry: unknown) => {
      fields(entry, ['requestId', 'result'])
      if (!isId(entry.requestId)) invalid()
      return { requestId: entry.requestId, result: decodeSendStatus(entry.result) }
    }),
  }
}
