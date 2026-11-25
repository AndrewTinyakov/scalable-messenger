import type { MessageChange, SnapshotMetadata } from '../../entities/message/historySnapshot'
import { isDateTime, isId, isSequence } from '../lib/validation'
import { decodeHistory, decodeMessage } from './decode'
import type { components } from './generated/schema'
import { decodeSnapshot, snapshotFields } from './snapshotDecode'
import { check, record } from './strictDecode'

export type AroundPage = Required<components['schemas']['MessageAroundResponse']> & SnapshotMetadata
export function decodeAround(value: unknown, chatId: string): AroundPage {
  const page = record(value, [
    'anchorMessageId',
    'messages',
    'hasOlder',
    'hasNewer',
    'coverageAfterSequence',
    'coverageThroughSequence',
    ...snapshotFields,
  ])
  check(
    (page.anchorMessageId === null || isId(page.anchorMessageId)) &&
      typeof page.hasOlder === 'boolean' &&
      typeof page.hasNewer === 'boolean',
  )
  const history = decodeHistory(
    Object.fromEntries([
      ...['messages', 'coverageAfterSequence', 'coverageThroughSequence', ...snapshotFields].map(
        (field) => [field, page[field]],
      ),
      ['nextSequence', page.coverageThroughSequence],
      ['hasMore', false],
    ]),
    chatId,
  )
  check(
    page.anchorMessageId === null
      ? history.messages.length === 0
      : history.messages.some((message) => message.id === page.anchorMessageId),
  )
  return {
    ...page,
    mutationSeq: history.mutationSeq,
    messages: history.messages,
  } as unknown as AroundPage
}

export type ChangesPage = Omit<
  Required<components['schemas']['MessageChangesResponse']>,
  'changes'
> &
  SnapshotMetadata & { changes: MessageChange[] }
export function decodeChanges(value: unknown, chatId: string): ChangesPage {
  const page = record(value, ['changes', 'lastSeq', 'nextSeq', 'resetRequired', ...snapshotFields])
  check(
    Array.isArray(page.changes) &&
      page.changes.length <= 100 &&
      isSequence(page.lastSeq) &&
      isSequence(page.nextSeq) &&
      typeof page.resetRequired === 'boolean',
  )
  const snapshot = decodeSnapshot(page)
  check(BigInt(page.nextSeq as string) <= BigInt(page.lastSeq as string))
  const changes = (page.changes as unknown[]).map((entry) => {
    const change = record(entry, [
      'seq',
      'kind',
      'message',
      'messageId',
      'sequence',
      'clearedThroughSequence',
    ])
    check(
      isSequence(change.seq) &&
        change.seq !== '0' &&
        BigInt(change.seq as string) <= BigInt(page.lastSeq as string),
    )
    check(change.messageId === null || isId(change.messageId))
    check(change.sequence === null || (isSequence(change.sequence) && change.sequence !== '0'))
    check(change.clearedThroughSequence === null || isSequence(change.clearedThroughSequence))
    if (change.kind === 'UPSERT') {
      const message = decodeMessage(change.message, chatId)
      check(
        change.messageId === message.id &&
          change.sequence === message.sequence &&
          change.clearedThroughSequence === null,
      )
      return { ...change, message } as unknown as MessageChange
    }
    check(change.message === null)
    if (change.kind === 'REMOVED')
      check(
        isId(change.messageId) &&
          isSequence(change.sequence) &&
          change.clearedThroughSequence === null,
      )
    else
      check(
        change.kind === 'CLEARED' &&
          change.messageId === null &&
          change.sequence === null &&
          isSequence(change.clearedThroughSequence),
      )
    return change as unknown as MessageChange
  })
  check(
    changes.every(
      (change, index) => index === 0 || BigInt(change.seq) >= BigInt(changes[index - 1].seq),
    ),
  )
  return { ...page, ...snapshot, changes } as unknown as ChangesPage
}

export function decodeVisibility(
  value: unknown,
): Required<components['schemas']['MessageVisibilityResponse']> & SnapshotMetadata {
  const page = record(value, [...snapshotFields, 'hidden'])
  check(typeof page.hidden === 'boolean')
  return { ...decodeSnapshot(page), hidden: page.hidden as boolean }
}

export function decodeResolved(
  value: unknown,
  chatId: string,
): Required<components['schemas']['MessageResolveResponse']> & SnapshotMetadata {
  const page = record(value, ['messages', ...snapshotFields])
  const snapshot = decodeSnapshot(page)
  check(Array.isArray(page.messages) && page.messages.length <= 100)
  const messages = (page.messages as unknown[]).map((message) => decodeMessage(message, chatId))
  check(new Set(messages.map((message) => message.id)).size === messages.length)
  check(
    messages.every(
      (message) =>
        BigInt(message.sequence) <= BigInt(snapshot.snapshotSequence) &&
        BigInt(message.sequence) > BigInt(snapshot.clearedThroughSequence) &&
        BigInt(message.sequence) > BigInt(snapshot.globalClearedThroughSequence),
    ),
  )
  return { ...snapshot, messages }
}

export function decodeDeletion(
  value: unknown,
): Required<components['schemas']['DeletionResponse']> {
  const result = record(value, [
    'operationId',
    'scope',
    'target',
    'clearedThroughSequence',
    'seq',
    'visibilitySeq',
    'state',
    'deletedRows',
  ])
  check(
    isId(result.operationId) &&
      ['SELF', 'EVERYONE'].includes(String(result.scope)) &&
      ['MESSAGES', 'HISTORY', 'CHAT'].includes(String(result.target)) &&
      ['ACCEPTED', 'COMPLETED'].includes(String(result.state)),
  )
  check(
    ['clearedThroughSequence', 'seq', 'visibilitySeq', 'deletedRows'].every((field) =>
      isSequence(result[field]),
    ),
  )
  return result as unknown as Required<components['schemas']['DeletionResponse']>
}
export type ChatState = components['schemas']['ChatStateResponse']
export function decodeChatState(value: unknown): ChatState {
  const sequences = [
    'lastSeq',
    'pinsSeq',
    'mutationFloor',
    'mutationSeq',
    'memberSeq',
    'visibilitySeq',
    'memberPinsSeq',
    'clearedThroughSequence',
    'globalClearedThroughSequence',
    'ownReadThrough',
    'otherReadThrough',
    'userSeq',
  ] as const
  const state = record(value, [...sequences, 'hidden'])
  check(sequences.every((field) => isSequence(state[field])) && typeof state.hidden === 'boolean')
  return state as ChatState
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

export type PinnedMessagePage = components['schemas']['PinnedMessagePageResponse']
export function decodePinnedMessages(value: unknown, chatId: string): PinnedMessagePage {
  const page = record(value, ['pins', 'totalCount', 'pinnedMessageIds', 'nextBeforeSequence'])
  check(
    Array.isArray(page.pins) &&
      page.pins.length <= 100 &&
      typeof page.totalCount === 'number' &&
      Number.isInteger(page.totalCount) &&
      page.totalCount >= page.pins.length &&
      page.totalCount <= 400 &&
      (page.nextBeforeSequence === null || isSequence(page.nextBeforeSequence)) &&
      Array.isArray(page.pinnedMessageIds) &&
      page.pinnedMessageIds.length === page.totalCount &&
      page.pinnedMessageIds.every(isId) &&
      new Set(page.pinnedMessageIds).size === page.pinnedMessageIds.length,
  )
  const pins = (page.pins as unknown[]).map((pin) => {
    const entry = record(pin, ['message', 'scope'])
    check(entry.scope === 'SELF' || entry.scope === 'EVERYONE')
    const message = decodeMessage(entry.message, chatId)
    check(!message.deletedAt)
    return { message, scope: entry.scope as 'SELF' | 'EVERYONE' }
  })
  check(new Set(pins.map((pin) => pin.message.id)).size === pins.length)
  const pinnedMessageIds = page.pinnedMessageIds as string[]
  check(pins.every((pin) => pinnedMessageIds.includes(pin.message.id)))
  return {
    pins,
    totalCount: page.totalCount as number,
    pinnedMessageIds,
    nextBeforeSequence: page.nextBeforeSequence as string | null,
  }
}
