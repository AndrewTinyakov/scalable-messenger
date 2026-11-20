import type { DeleteScope, DeleteTarget } from '../../entities/message/historySnapshot'
import type { Session } from '../../entities/session/model'
import { runtimeConfig } from '../config/runtime'
import { isRecord } from '../lib/validation'
import { decodeActiveSessions, decodeRevokedSessions } from './accountDecode'
import {
  decodeChat,
  decodeChatPreferences,
  decodeChats,
  decodeDirectChat,
  decodeGroupMembers,
  decodeHistory,
  decodeMessage,
  decodePinnedChats,
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
  decodeChatState,
  decodeDeletion,
  decodePinnedMessages,
  decodeReadProgress,
  decodeReaders,
  decodeReads,
  decodeResolved,
  decodeVisibility,
} from './featureDecode'
import type { components, paths } from './generated/schema'

const apiBase = runtimeConfig.apiBaseUrl
const routes = {
  login: '/v1/auth/login',
  register: '/v1/auth/register',
  session: '/v1/auth/session',
  logout: '/v1/auth/logout',
  password: '/v1/auth/password',
  sessions: '/v1/auth/sessions',
  activeSession: '/v1/auth/sessions/{sessionId}',
  revokeOtherSessions: '/v1/auth/sessions/revoke-others',
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
  state: '/v1/chats/{id}/state',
  messageReads: '/v1/chats/{id}/messages/{messageId}/reads',
  pinnedChats: '/v1/chats/pinned',
  chatPin: '/v1/chats/{id}/pin',
  chatMute: '/v1/chats/{id}/mute',
  unreadMark: '/v1/chats/{id}/unread-mark',
  messagePins: '/v1/chats/{id}/pins',
  messagePin: '/v1/chats/{id}/pins/{messageId}',
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

export type ApiErrorCode = components['schemas']['ApiProblem']['code']
export type ApiFieldError = components['schemas']['ApiFieldError']

const apiErrorCodes = {
  VALIDATION_FAILED: true,
  UNAUTHORIZED: true,
  INVALID_CREDENTIALS: true,
  FORBIDDEN: true,
  NOT_FOUND: true,
  USERNAME_TAKEN: true,
  PASSWORD_CHANGED: true,
  VERSION_CHANGED: true,
  REQUEST_ID_REUSED: true,
  PIN_LIMIT: true,
  PIN_ORDER_CHANGED: true,
  TOO_MANY_ATTEMPTS: true,
  INTERNAL_SERVER_ERROR: true,
  SERVICE_UNAVAILABLE: true,
} satisfies Record<ApiErrorCode, true>

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfter = 0,
    public code: ApiErrorCode | null = null,
    public fieldErrors: ApiFieldError[] = [],
  ) {
    super(message)
  }

  fieldError(field: string): string | undefined {
    return this.fieldErrors.find((error) => error.field === field)?.message
  }
}

function problemCode(value: unknown): ApiErrorCode | null {
  return typeof value === 'string' && Object.hasOwn(apiErrorCodes, value)
    ? (value as ApiErrorCode)
    : null
}

function problemFieldErrors(value: unknown): ApiFieldError[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (item): item is ApiFieldError =>
      isRecord(item) && typeof item.field === 'string' && typeof item.message === 'string',
  )
}

export function isWaitingFailure(cause: unknown): boolean {
  return cause instanceof ApiError
    ? cause.status === 429 || [500, 502, 503, 504].includes(cause.status)
    : cause instanceof TypeError ||
        (cause instanceof Error && cause.message === 'Request timed out. Try again.')
}

async function attempt<T>(
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
      signal: options.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal,
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
      let code: ApiErrorCode | null = null
      let fieldErrors: ApiFieldError[] = []
      try {
        const body: unknown = await response.json()
        if (isRecord(body)) {
          const detail = [body.detail, body.message, body.title].find(
            (value) => typeof value === 'string' && value.length > 0,
          )
          if (typeof detail === 'string') message = detail
          code = problemCode(body.code)
          fieldErrors = problemFieldErrors(body.errors)
        }
      } catch {}
      const value = response.headers.get('Retry-After')
      const retryAfter = value
        ? /^\d+(\.\d+)?$/.test(value)
          ? Number(value) * 1000
          : Math.max(0, Date.parse(value) - Date.now()) || 0
        : 0
      throw new ApiError(response.status, message, retryAfter, code, fieldErrors)
    }
    return decode(response.status === 204 ? undefined : ((await response.json()) as unknown))
  } catch (cause) {
    if (controller.signal.aborted) throw controller.signal.reason
    throw cause
  } finally {
    clearTimeout(timer)
  }
}

async function request<T>(
  path: string,
  decode: (value: unknown) => T,
  options: RequestInit = {},
): Promise<T> {
  const retryBudget =
    !options.method || (options.method === 'POST' && /\/deletions$/.test(path)) ? 3 : 0
  for (let failures = 0; ; failures++) {
    options.signal?.throwIfAborted()
    try {
      return await attempt(path, decode, options)
    } catch (cause) {
      options.signal?.throwIfAborted()
      const retryable =
        cause instanceof ApiError
          ? [429, 500, 502, 503, 504].includes(cause.status)
          : cause instanceof TypeError ||
            (cause instanceof Error && cause.message === 'Request timed out. Try again.')
      if (
        !retryable ||
        failures >= (cause instanceof ApiError && cause.status === 429 ? 3 : retryBudget)
      )
        throw cause
      const retryAfter =
        cause instanceof ApiError && Number.isFinite(cause.retryAfter)
          ? Math.max(0, cause.retryAfter)
          : 0
      const delay = Math.min(
        30000,
        Math.max(500 * 2 ** failures * (0.75 + Math.random() * 0.5), retryAfter),
      )
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer)
          reject(options.signal?.reason)
        }
        const timer = setTimeout(() => {
          options.signal?.removeEventListener('abort', abort)
          resolve()
        }, delay)
        options.signal?.addEventListener('abort', abort, { once: true })
        if (options.signal?.aborted) abort()
      })
    }
  }
}

function noContent(value: unknown): void {
  if (value !== undefined) throw new Error('Invalid response from server')
}

export const api = {
  login(username: string, password: string, deviceId: string) {
    const body: components['schemas']['AuthRequest'] = { username, password, deviceId }
    return attempt(endpoint(routes.login), decodeSession, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  },
  register(username: string, password: string, deviceId: string) {
    const body: components['schemas']['AuthRequest'] = { username, password, deviceId }
    return attempt(endpoint(routes.register), decodeSession, {
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
      sessions(signal?: AbortSignal) {
        return authenticated(endpoint(routes.sessions), decodeActiveSessions, { signal })
      },
      revokeSession(sessionId: string): Promise<void> {
        return authenticated(endpoint(routes.activeSession, { sessionId }), noContent, {
          method: 'DELETE',
        })
      },
      revokeOtherSessions() {
        return authenticated(endpoint(routes.revokeOtherSessions), decodeRevokedSessions, {
          method: 'POST',
        })
      },
      changePassword(currentPassword: string, newPassword: string) {
        const body: components['schemas']['ChangePasswordRequest'] = {
          currentPassword,
          newPassword,
        }
        return attempt(endpoint(routes.password), decodeRevokedSessions, {
          method: 'POST',
          body: JSON.stringify(body),
          headers,
        })
      },
      wsTicket(signal?: AbortSignal) {
        return authenticated(endpoint(routes.wsTicket), decodeTicket, { method: 'POST', signal })
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
      messageChanges(chatId: string, afterSeq: string) {
        return authenticated(
          endpoint(routes.changes, { id: chatId }, { afterSeq, limit: 100 }),
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
      chatState(chatId: string, minSeq?: string) {
        return authenticated(
          endpoint(routes.state, { id: chatId }, minSeq && minSeq !== '0' ? { minSeq } : {}),
          decodeChatState,
        )
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
      pinChat(chatId: string, pinned: boolean) {
        return authenticated(endpoint(routes.chatPin, { id: chatId }), decodePinnedChats, {
          method: pinned ? 'PUT' : 'DELETE',
        })
      },
      reorderPinnedChats(chatIds: string[]) {
        const body: components['schemas']['ReorderPinnedChatsRequest'] = { chatIds }
        return authenticated(endpoint(routes.pinnedChats), decodePinnedChats, {
          method: 'PUT',
          body: JSON.stringify(body),
        })
      },
      muteChat(chatId: string, durationSeconds: number | null) {
        const body: components['schemas']['MuteChatRequest'] = { durationSeconds }
        return authenticated(
          endpoint(routes.chatMute, { id: chatId }),
          (value) => decodeChatPreferences(value, chatId),
          { method: 'PUT', body: JSON.stringify(body) },
        )
      },
      unmuteChat(chatId: string) {
        return authenticated(
          endpoint(routes.chatMute, { id: chatId }),
          (value) => decodeChatPreferences(value, chatId),
          { method: 'DELETE' },
        )
      },
      markUnread(chatId: string, unread: boolean) {
        return authenticated(
          endpoint(routes.unreadMark, { id: chatId }),
          (value) => decodeChatPreferences(value, chatId),
          { method: unread ? 'PUT' : 'DELETE' },
        )
      },
      pinnedMessages(chatId: string, beforeSequence?: string) {
        return authenticated(
          endpoint(
            routes.messagePins,
            { id: chatId },
            { limit: 50, ...(beforeSequence ? { beforeSequence } : {}) },
          ),
          (value) => decodePinnedMessages(value, chatId),
        )
      },
      pinMessage(chatId: string, messageId: string, scope: 'SELF' | 'EVERYONE') {
        const body: components['schemas']['PinMessageRequest'] = { scope }
        return authenticated(endpoint(routes.messagePin, { id: chatId, messageId }), noContent, {
          method: 'PUT',
          body: JSON.stringify(body),
        })
      },
      unpinMessage(chatId: string, messageId: string) {
        return authenticated(endpoint(routes.messagePin, { id: chatId, messageId }), noContent, {
          method: 'DELETE',
        })
      },
      unpinAllMessages(chatId: string) {
        return authenticated(endpoint(routes.messagePins, { id: chatId }), noContent, {
          method: 'DELETE',
        })
      },
      sendStatus(requestId: string) {
        return authenticated(endpoint(routes.sendStatus, { requestId }), decodeSendStatus)
      },
      sendStatuses(requestIds: string[], signal?: AbortSignal) {
        const body: components['schemas']['SendStatusesRequest'] = { requestIds }
        return authenticated(endpoint(routes.sendStatuses), decodeSendStatuses, {
          method: 'POST',
          body: JSON.stringify(body),
          signal,
        }).then((response) => response.results)
      },
    }
  },
}
