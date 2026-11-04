import type { DeleteScope, DeleteTarget } from '../../entities/message/historySnapshot'
import type { Session } from '../../entities/session/model'
import { isRecord } from '../lib/validation'
import {
  decodeChat,
  decodeChats,
  decodeDirectChat,
  decodeGroupMembers,
  decodeHistory,
  decodeMessage,
  decodeSendStatus,
  decodeSendStatuses,
  decodeSession,
  decodeSessionStatus,
  decodeTicket,
  decodeUser,
  decodeUsers,
} from './decode'
import {
  decodeAround,
  decodeChanges,
  decodeDeletion,
  decodeReadProgress,
  decodeReaders,
  decodeReads,
  decodeResolved,
  decodeVisibility,
} from './featureDecode'
import type { components, paths } from './generated/schema'

const apiBase = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8081/api').replace(
  /\/$/,
  '',
)
const routes = {
  login: '/v1/auth/login',
  register: '/v1/auth/register',
  session: '/v1/auth/session',
  logout: '/v1/auth/logout',
  wsTicket: '/v1/auth/ws-ticket',
  users: '/v1/users',
  user: '/v1/users/{userId}',
  chats: '/v1/chats',
  chat: '/v1/chats/{id}',
  directChat: '/v1/chats/direct/{userId}',
  groups: '/v1/chats/groups',
  addGroupMembers: '/v1/chats/{id}/members',
  removeGroupMember: '/v1/chats/{id}/members/{userId}',
  messages: '/v1/chats/{id}/messages',
  around: '/v1/chats/{id}/messages/around',
  changes: '/v1/chats/{id}/messages/changes',
  message: '/v1/chats/{id}/messages/{messageId}',
  visibility: '/v1/chats/{id}/visibility',
  resolveMessages: '/v1/chats/{id}/messages/resolve',
  deletions: '/v1/chats/{id}/deletions',
  deletion: '/v1/chats/{id}/deletions/{operationId}',
  reads: '/v1/chats/{id}/reads',
  messageReads: '/v1/chats/{id}/messages/{messageId}/reads',
  sendStatus: '/v1/sends/{requestId}',
  sendStatuses: '/v1/sends/status',
} as const satisfies Record<string, keyof paths>

function endpoint(
  path: keyof paths,
  params: Record<string, string> = {},
  query?: Record<string, string | number>,
): string {
  const resolved = path.replace(/\{([^}]+)\}/g, (_, key: string) => {
    if (!params[key]) throw new Error(`Missing URL parameter: ${key}`)
    return encodeURIComponent(params[key])
  })
  const search = query
    ? `?${new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]))}`
    : ''
  return `${resolved}${search}`
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

async function request<T>(
  path: string,
  decode: (value: unknown) => T,
  options: RequestInit = {},
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error('Request timed out. Try again.')),
    15000,
  )
  try {
    const response = await fetch(`${apiBase}${path}`, {
      ...options,
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'include',
      redirect: 'error',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.method && !['GET', 'HEAD', 'OPTIONS'].includes(options.method)
          ? { 'X-Messenger-CSRF': '1' }
          : {}),
        ...options.headers,
      },
    })
    if (!response.ok) {
      let message = `Request failed (${response.status})`
      try {
        const body: unknown = await response.json()
        if (isRecord(body)) {
          const detail = [body.detail, body.message, body.title].find(
            (value) => typeof value === 'string' && value.length > 0,
          )
          if (typeof detail === 'string') message = detail
        }
      } catch {}
      throw new ApiError(response.status, message)
    }
    return decode(response.status === 204 ? undefined : ((await response.json()) as unknown))
  } catch (cause) {
    if (controller.signal.aborted) throw controller.signal.reason
    throw cause
  } finally {
    clearTimeout(timer)
  }
}

function noContent(value: unknown): void {
  if (value !== undefined) throw new Error('Invalid response from server')
}

export const api = {
  login(username: string, password: string, deviceId: string) {
    const body: components['schemas']['AuthRequest'] = { username, password, deviceId }
    return request(endpoint(routes.login), decodeSession, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  },
  register(username: string, password: string, deviceId: string) {
    const body: components['schemas']['AuthRequest'] = { username, password, deviceId }
    return request(endpoint(routes.register), decodeSession, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  },
  session() {
    return request(endpoint(routes.session), decodeSessionStatus)
  },
  forSession(session: Session) {
    const headers = { 'X-Messenger-User': session.user.id, 'X-Messenger-Device': session.deviceId }
    function authenticated<T>(
      path: string,
      decode: (value: unknown) => T,
      options: RequestInit = {},
    ): Promise<T> {
      return request(path, decode, { ...options, headers: { ...options.headers, ...headers } })
    }
    return {
      logout(): Promise<void> {
        return authenticated(endpoint(routes.logout), noContent, { method: 'POST' })
      },
      wsTicket() {
        return authenticated(endpoint(routes.wsTicket), decodeTicket, { method: 'POST' })
      },
      addGroupMembers(chatId: string, memberIds: string[]) {
        const body: components['schemas']['AddGroupMembersRequest'] = { memberIds }
        return authenticated(endpoint(routes.addGroupMembers, { id: chatId }), noContent, {
          method: 'POST',
          body: JSON.stringify(body),
        })
      },
      groupMembers(chatId: string, afterUserId?: string) {
        return authenticated(
          endpoint(
            routes.addGroupMembers,
            { id: chatId },
            { limit: 50, ...(afterUserId ? { afterUserId } : {}) },
          ),
          decodeGroupMembers,
        )
      },
      removeGroupMember(chatId: string, userId: string) {
        return authenticated(
          endpoint(routes.removeGroupMember, { id: chatId, userId }),
          noContent,
          { method: 'DELETE' },
        )
      },
      users(query: string) {
        return authenticated(endpoint(routes.users, {}, { query }), decodeUsers)
      },
      user(userId: string) {
        return authenticated(endpoint(routes.user, { userId }), (value) => {
          const user = decodeUser(value)
          if (user.id !== userId) throw new Error('Invalid response from server')
          return user
        })
      },
      chats(cursor?: string) {
        return authenticated(
          endpoint(routes.chats, {}, { limit: 100, ...(cursor ? { cursor } : {}) }),
          decodeChats,
        )
      },
      chat(chatId: string) {
        return authenticated(endpoint(routes.chat, { id: chatId }), decodeChat)
      },
      directChat(userId: string) {
        return authenticated(endpoint(routes.directChat, { userId }), (value) =>
          decodeDirectChat(value, userId, session.user.id),
        )
      },
      createGroup(name: string, memberIds: string[]) {
        const body: components['schemas']['CreateGroupChatRequest'] = { name, memberIds }
        return authenticated(endpoint(routes.groups), decodeChat, {
          method: 'POST',
          body: JSON.stringify(body),
        })
      },
      messages(chatId: string, afterSeq: string, limit = 50) {
        return authenticated(
          endpoint(routes.messages, { id: chatId }, { afterSeq, limit }),
          (value) => decodeHistory(value, chatId),
        )
      },
      latestMessages(chatId: string, limit = 50) {
        return authenticated(endpoint(routes.messages, { id: chatId }, { limit }), (value) =>
          decodeHistory(value, chatId),
        )
      },
      olderMessages(chatId: string, beforeSeq: string, limit = 50) {
        return authenticated(
          endpoint(routes.messages, { id: chatId }, { beforeSeq, limit }),
          (value) => decodeHistory(value, chatId),
        )
      },
      aroundMessage(chatId: string, messageId?: string, anchorSequence?: string) {
        return authenticated(
          endpoint(
            routes.around,
            { id: chatId },
            {
              ...(messageId ? { messageId } : {}),
              ...(anchorSequence ? { anchorSequence } : {}),
              limit: 50,
            },
          ),
          (value) => decodeAround(value, chatId),
        )
      },
      visibility(chatId: string) {
        return authenticated(endpoint(routes.visibility, { id: chatId }), decodeVisibility)
      },
      resolveMessages(chatId: string, messageIds: string[]) {
        if (messageIds.length > 100 || new Set(messageIds).size !== messageIds.length)
          throw new Error('Choose at most 100 messages')
        return authenticated(
          endpoint(routes.resolveMessages, { id: chatId }),
          (value) => {
            const page = decodeResolved(value, chatId)
            if (page.messages.some((message) => !messageIds.includes(message.id)))
              throw new Error('Invalid response from server')
            return page
          },
          { method: 'POST', body: JSON.stringify({ messageIds }) },
        )
      },
      delete(
        chatId: string,
        requestId: string,
        scope: DeleteScope,
        target: DeleteTarget,
        messageIds?: string[],
      ) {
        const body: components['schemas']['DeletionRequest'] = {
          requestId,
          scope,
          target,
          ...(messageIds ? { messageIds } : {}),
        }
        return authenticated(
          endpoint(routes.deletions, { id: chatId }),
          (value) => {
            const result = decodeDeletion(value)
            if (
              result.operationId !== requestId ||
              result.scope !== scope ||
              result.target !== target
            )
              throw new Error('Invalid response from server')
            return result
          },
          { method: 'POST', body: JSON.stringify(body) },
        )
      },
      deletion(chatId: string, operationId: string) {
        return authenticated(endpoint(routes.deletion, { id: chatId, operationId }), (value) => {
          const result = decodeDeletion(value)
          if (result.operationId !== operationId) throw new Error('Invalid response from server')
          return result
        })
      },
      messageChanges(chatId: string, afterRevision: string) {
        return authenticated(
          endpoint(routes.changes, { id: chatId }, { afterRevision, limit: 100 }),
          (value) => decodeChanges(value, chatId),
        )
      },
      editMessage(chatId: string, messageId: string, body: string, expectedVersion: string) {
        const payload: components['schemas']['EditMessageRequest'] = { body, expectedVersion }
        return authenticated(
          endpoint(routes.message, { id: chatId, messageId }),
          (value) => decodeMessage(value, chatId),
          { method: 'PATCH', body: JSON.stringify(payload) },
        )
      },
      deleteMessage(chatId: string, messageId: string, expectedVersion: string) {
        return authenticated(
          endpoint(routes.message, { id: chatId, messageId }, { expectedVersion }),
          (value) => decodeMessage(value, chatId),
          { method: 'DELETE' },
        )
      },
      deleteChat(chatId: string) {
        return authenticated(endpoint(routes.chat, { id: chatId }), noContent, { method: 'DELETE' })
      },
      reads(chatId: string) {
        return authenticated(endpoint(routes.reads, { id: chatId }), decodeReads)
      },
      advanceRead(chatId: string, throughSequence: string) {
        const payload: components['schemas']['AdvanceReadRequest'] = { throughSequence }
        return authenticated(endpoint(routes.reads, { id: chatId }), decodeReadProgress, {
          method: 'POST',
          body: JSON.stringify(payload),
        })
      },
      messageReaders(chatId: string, messageId: string, afterUserId?: string) {
        return authenticated(
          endpoint(
            routes.messageReads,
            { id: chatId, messageId },
            { limit: 50, ...(afterUserId ? { afterUserId } : {}) },
          ),
          decodeReaders,
        )
      },
      sendStatus(requestId: string) {
        return authenticated(endpoint(routes.sendStatus, { requestId }), decodeSendStatus)
      },
      sendStatuses(requestIds: string[]) {
        const body: components['schemas']['SendStatusesRequest'] = { requestIds }
        return authenticated(endpoint(routes.sendStatuses), decodeSendStatuses, {
          method: 'POST',
          body: JSON.stringify(body),
        }).then((response) => response.results)
      },
    }
  },
}
