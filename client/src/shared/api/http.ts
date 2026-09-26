import type { Conversation } from '../../entities/conversation/model'
import type { Session, User } from '../../entities/session/model'
import type { components, paths } from './generated/schema'

const apiBase = '/api'
const routes = {
  login: '/v1/auth/login',
  register: '/v1/auth/register',
  session: '/v1/auth/session',
  users: '/v1/users',
  conversations: '/v1/conversations',
  direct: '/v1/conversations/direct',
  groups: '/v1/conversations/groups',
  messages: '/v1/conversations/{id}/messages',
  sendStatus: '/v1/conversations/{id}/send-status/{requestId}',
} as const satisfies Record<string, keyof paths>

function endpoint(path: keyof paths, params: Record<string, string> = {}, query?: Record<string, string | number>): string {
  const resolved = path.replace(/\{([^}]+)\}/g, (_, key: string) => {
    if (!params[key]) throw new Error(`Missing URL parameter: ${key}`)
    return encodeURIComponent(params[key])
  })
  const search = query ? `?${new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]))}` : ''
  return `${resolved}${search}`
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

async function request<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })
  if (!response.ok) {
    let message = `Request failed (${response.status})`
    try {
      const body = await response.json() as { detail?: string; message?: string; title?: string }
      message = body.detail || body.message || body.title || message
    } catch { /* The server can return an empty error body. */ }
    throw new ApiError(response.status, message)
  }
  return response.json() as Promise<T>
}

export const api = {
  login(username: string, password: string, deviceId: string) {
    const body: components['schemas']['Credentials'] = { username, password, deviceId }
    return request<Session>(endpoint(routes.login), { method: 'POST', body: JSON.stringify(body) })
  },
  register(username: string, password: string, deviceId: string) {
    const body: components['schemas']['Credentials'] = { username, password, deviceId }
    return request<Session>(endpoint(routes.register), { method: 'POST', body: JSON.stringify(body) })
  },
  session(token: string) {
    return request<components['schemas']['SessionView']>(endpoint(routes.session), {}, token)
  },
  users(token: string, query: string) {
    return request<User[]>(endpoint(routes.users, {}, { query }), {}, token)
  },
  conversations(token: string) {
    return request<components['schemas']['ConversationView'][]>(endpoint(routes.conversations), {}, token).then(normalizeConversations)
  },
  createDirect(token: string, userId: string) {
    const body: components['schemas']['DirectRequest'] = { userId }
    return request<components['schemas']['ConversationView']>(endpoint(routes.direct), { method: 'POST', body: JSON.stringify(body) }, token).then(normalizeConversation)
  },
  createGroup(token: string, name: string, memberIds: string[]) {
    const body: components['schemas']['GroupRequest'] = { name, memberIds }
    return request<components['schemas']['ConversationView']>(endpoint(routes.groups), { method: 'POST', body: JSON.stringify(body) }, token).then(normalizeConversation)
  },
  messages(token: string, conversationId: string, afterSeq: string, limit = 50) {
    return request<components['schemas']['HistoryView']>(
      endpoint(routes.messages, { id: conversationId }, { afterSeq, limit }),
      {}, token,
    )
  },
  sendStatus(token: string, conversationId: string, requestId: string) {
    return request<components['schemas']['SendStatusView']>(
      endpoint(routes.sendStatus, { id: conversationId, requestId }), {}, token,
    ).then(normalizeSendStatus)
  },
}

function normalizeConversation(value: components['schemas']['ConversationView']): Conversation {
  if (value.kind !== 'direct' && value.kind !== 'group') throw new Error(`Unknown conversation kind: ${value.kind}`)
  return value as Conversation
}

function normalizeConversations(values: components['schemas']['ConversationView'][]): Conversation[] {
  return values.map(normalizeConversation)
}

function normalizeSendStatus(value: components['schemas']['SendStatusView']):
  Omit<components['schemas']['SendStatusView'], 'status'> & { status: 'unknown' | 'saved' | 'rejected' } {
  if (value.status !== 'unknown' && value.status !== 'saved' && value.status !== 'rejected') {
    throw new Error(`Unknown send status: ${value.status}`)
  }
  return value as Omit<components['schemas']['SendStatusView'], 'status'> & { status: 'unknown' | 'saved' | 'rejected' }
}
