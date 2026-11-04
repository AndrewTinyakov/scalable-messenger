import type { Message } from '../../entities/message/model'
import { isDateTime, isId, isRecord, isSequence } from '../lib/validation'
import { decodeMessage } from './decode'
import type { components } from './generated/schema'

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error('Invalid response from server')
  return value
}
function check(condition: boolean): asserts condition {
  if (!condition) throw new Error('Invalid response from server')
}
export function decodeAround(
  value: unknown,
  chatId: string,
): components['schemas']['MessageAroundResponse'] {
  const page = record(value, [
    'anchorMessageId',
    'messages',
    'hasOlder',
    'hasNewer',
    'mutationRevision',
  ])
  check(
    isId(page.anchorMessageId) &&
      Array.isArray(page.messages) &&
      page.messages.length <= 50 &&
      typeof page.hasOlder === 'boolean' &&
      typeof page.hasNewer === 'boolean' &&
      isSequence(page.mutationRevision),
  )
  const messages = page.messages.map((message) => decodeMessage(message, chatId))
  check(messages.some((message) => message.id === page.anchorMessageId))
  return {
    anchorMessageId: page.anchorMessageId as string,
    messages,
    hasOlder: page.hasOlder as boolean,
    hasNewer: page.hasNewer as boolean,
    mutationRevision: page.mutationRevision as string,
  }
}
export function decodeChanges(
  value: unknown,
  chatId: string,
): components['schemas']['MessageChangesResponse'] {
  const page = record(value, ['changes', 'lastRevision', 'nextRevision', 'resetRequired'])
  check(
    Array.isArray(page.changes) &&
      page.changes.length <= 100 &&
      isSequence(page.lastRevision) &&
      isSequence(page.nextRevision) &&
      typeof page.resetRequired === 'boolean',
  )
  return {
    changes: page.changes.map((entry) => {
      const change = record(entry, ['revision', 'message'])
      check(isSequence(change.revision))
      return { revision: change.revision as string, message: decodeMessage(change.message, chatId) }
    }),
    lastRevision: page.lastRevision as string,
    nextRevision: page.nextRevision as string,
    resetRequired: page.resetRequired as boolean,
  }
}
export function decodeReads(value: unknown): components['schemas']['ReadSummaryResponse'] {
  const summary = record(value, ['throughSequence', 'maxOtherReadSequence', 'serverTime'])
  check(
    isSequence(summary.throughSequence) &&
      isSequence(summary.maxOtherReadSequence) &&
      isDateTime(summary.serverTime),
  )
  return summary as { throughSequence: string; maxOtherReadSequence: string; serverTime: string }
}
export function decodeReadProgress(value: unknown): components['schemas']['ReadProgressResponse'] {
  const progress = record(value, ['throughSequence', 'readAt', 'serverTime'])
  check(
    isSequence(progress.throughSequence) &&
      (progress.readAt === null || isDateTime(progress.readAt)) &&
      isDateTime(progress.serverTime),
  )
  return progress as { throughSequence: string; readAt: string | null; serverTime: string }
}
export type ReaderPage = components['schemas']['MessageReadsResponse']
export function decodeReaders(value: unknown): ReaderPage {
  const page = record(value, [
    'readers',
    'nextUserId',
    'detailsAvailable',
    'serverTime',
    'detailsExpiresAt',
  ])
  check(
    Array.isArray(page.readers) &&
      page.readers.length <= 50 &&
      (page.nextUserId === null || isId(page.nextUserId)) &&
      typeof page.detailsAvailable === 'boolean' &&
      isDateTime(page.serverTime) &&
      isDateTime(page.detailsExpiresAt),
  )
  for (const entry of page.readers) {
    const reader = record(entry, ['userId', 'username', 'readAt'])
    check(
      isId(reader.userId) &&
        typeof reader.username === 'string' &&
        reader.username.length > 0 &&
        reader.username.length <= 40 &&
        isDateTime(reader.readAt),
    )
  }
  return page as unknown as ReaderPage
}
export type MessageChange = { revision: string; message: Message }
