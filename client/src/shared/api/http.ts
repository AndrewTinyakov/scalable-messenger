import type { Chat } from '../../entities/chat/model'
import type { Session, User } from '../../entities/session/model'
import type { components, paths } from './generated/schema'

const apiBase = '/api'
const routes = {
  login: '/v1/auth/login',
  register: '/v1/auth/register',
  session: '/v1/auth/session',
  logout: '/v1/auth/logout',
  wsTicket: '/v1/auth/ws-ticket',
  users: '/v1/users',
  chats: '/v1/chats',
  chat: '/v1/chats/{id}',
  groups: '/v1/chats/groups',
  addGroupMembers: '/v1/chats/{id}/members',
  messages: '/v1/chats/{id}/messages',
  sendStatus: '/v1/sends/{requestId}',
  sendStatuses: '/v1/sends/status',
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
    const body: components['schemas']['AuthRequest'] = { username, password, deviceId }
    return request<Session>(endpoint(routes.login), { method: 'POST', body: JSON.stringify(body) })
  },
  register(username: string, password: string, deviceId: string) {
    const body: components['schemas']['AuthRequest'] = { username, password, deviceId }
    return request<Session>(endpoint(routes.register), { method: 'POST', body: JSON.stringify(body) })
  },
  session(token: string) {
    return request<components['schemas']['SessionResponse']>(endpoint(routes.session), {}, token)
  },
  async logout(token: string): Promise<void> {
    const response = await fetch(`${apiBase}${endpoint(routes.logout)}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
    })
    if (!response.ok) throw new ApiError(response.status, `Could not sign out (${response.status})`)
  },
  wsTicket(token: string) {
    return request<components['schemas']['WsTicketResponse']>(endpoint(routes.wsTicket), { method: 'POST' }, token)
  },
  addGroupMembers(token: string, chatId: string, memberIds: string[]) {
    const body: components['schemas']['AddGroupMembersRequest'] = { memberIds }
    return fetch(`${apiBase}${endpoint(routes.addGroupMembers, { id: chatId })}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then((response) => { if (!response.ok) throw new ApiError(response.status, `Could not add members (${response.status})`) })
  },
  users(token: string, query: string) {
    return request<User[]>(endpoint(routes.users, {}, { query }), {}, token)
  },
  chats(token: string, cursor?: string) {
    return request<components['schemas']['ChatPageResponse']>(
      endpoint(routes.chats, {}, { limit: 100, ...(cursor ? { cursor } : {}) }), {}, token,
    ).then((page) => ({ chats: normalizeChats(page.chats), nextCursor: page.nextCursor ?? null }))
  },
  chat(token: string, chatId: string) {
    return request<components['schemas']['ChatResponse']>(endpoint(routes.chat, { id: chatId }), {}, token).then(normalizeChat)
  },
  createGroup(token: string, name: string, memberIds: string[]) {
    const body: components['schemas']['CreateGroupChatRequest'] = { name, memberIds }
    return request<components['schemas']['ChatResponse']>(endpoint(routes.groups), { method: 'POST', body: JSON.stringify(body) }, token).then(normalizeChat)
  },
  messages(token: string, chatId: string, afterSeq: string, limit = 50) {
    return request<components['schemas']['MessageHistoryResponse']>(
      endpoint(routes.messages, { id: chatId }, { afterSeq, limit }),
      {}, token,
    )
  },
  latestMessages(token: string, chatId: string, limit = 50) {
    return request<components['schemas']['MessageHistoryResponse']>(
      endpoint(routes.messages, { id: chatId }, { limit }), {}, token,
    )
  },
  olderMessages(token: string, chatId: string, beforeSeq: string, limit = 50) {
    return request<components['schemas']['MessageHistoryResponse']>(
      endpoint(routes.messages, { id: chatId }, { beforeSeq, limit }), {}, token,
    )
  },
  sendStatus(token: string, requestId: string) {
    return request<components['schemas']['SendStatusResponse']>(
      endpoint(routes.sendStatus, { requestId }), {}, token,
    ).then(normalizeSendStatus)
  },
  sendStatuses(token: string, requestIds: string[]) {
    const body: components['schemas']['SendStatusesRequest'] = { requestIds }
    return request<components['schemas']['SendStatusesResponse']>(
      endpoint(routes.sendStatuses), { method: 'POST', body: JSON.stringify(body) }, token,
    ).then((response) => response.results.map((entry) => ({ requestId: entry.requestId, result: normalizeSendStatus(entry.result) })))
  },
}

function normalizeChat(value: components['schemas']['ChatResponse']): Chat {
  if (value.kind !== 'direct' && value.kind !== 'group') throw new Error(`Unknown chat kind: ${value.kind}`)
  return value as Chat
}

function normalizeChats(values: components['schemas']['ChatResponse'][]): Chat[] {
  return values.map(normalizeChat)
}

function normalizeSendStatus(value: components['schemas']['SendStatusResponse']):
  Omit<components['schemas']['SendStatusResponse'], 'status'> & { status: 'unknown' | 'saved' | 'rejected' } {
  if (value.status !== 'unknown' && value.status !== 'saved' && value.status !== 'rejected') {
    throw new Error(`Unknown send status: ${value.status}`)
  }
  return value as Omit<components['schemas']['SendStatusResponse'], 'status'> & { status: 'unknown' | 'saved' | 'rejected' }
}
