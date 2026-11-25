import type { ActiveSession } from '../../entities/session/model'
import { isDateTime } from '../lib/validation'
import { check, record } from './strictDecode'

function decodeActiveSession(value: unknown): ActiveSession {
  const session = record(value, ['id', 'deviceLabel', 'createdAt', 'lastUsedAt', 'current'])
  check(
    typeof session.id === 'string' &&
      /^[0-9a-f]{64}$/.test(session.id) &&
      typeof session.deviceLabel === 'string' &&
      session.deviceLabel.length > 0 &&
      session.deviceLabel.length <= 64 &&
      isDateTime(session.createdAt) &&
      isDateTime(session.lastUsedAt) &&
      typeof session.current === 'boolean',
  )
  return session as unknown as ActiveSession
}

export function decodeActiveSessions(value: unknown): ActiveSession[] {
  const page = record(value, ['sessions'])
  check(Array.isArray(page.sessions))
  const sessions = page.sessions.map(decodeActiveSession)
  check(
    new Set(sessions.map((session) => session.id)).size === sessions.length &&
      sessions.filter((session) => session.current).length <= 1,
  )
  return sessions
}

export function decodeRevokedSessions(value: unknown): number {
  const result = record(value, ['revokedSessions'])
  check(
    typeof result.revokedSessions === 'number' &&
      Number.isSafeInteger(result.revokedSessions) &&
      result.revokedSessions >= 0,
  )
  return result.revokedSessions
}
