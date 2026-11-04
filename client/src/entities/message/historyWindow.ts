import { mergeMessages, type Message } from './model'

export const HISTORY_PAGE_SIZE = 50
export const MAX_VISIBLE_MESSAGES = 200
export const MAX_CATCH_UP_MESSAGES = 500

type Direction = 'older' | 'newer'

export function advanceAppliedSequence(current: string, incoming: Message[]): string {
  const present = new Set(incoming.map((message) => message.sequence))
  let next = BigInt(current)
  while (present.has((next + 1n).toString())) next += 1n
  return next.toString()
}

export function hasNewAppliedMessages(
  before: string,
  after: string,
  dismissedThrough: string,
): boolean {
  return BigInt(after) > BigInt(before) && BigInt(after) > BigInt(dismissedThrough)
}

export function historyBoundaryBefore(messages: Message[]): string {
  return messages.length ? (BigInt(messages[0].sequence) - 1n).toString() : '0'
}

export function isContiguous(messages: Message[]): boolean {
  return messages.every(
    (message, index) =>
      index === 0 || BigInt(message.sequence) === BigInt(messages[index - 1].sequence) + 1n,
  )
}

export function replaceWindow(incoming: Message[], sparse = false): Message[] {
  const sorted = mergeMessages([], incoming)
  if (!sparse && !isContiguous(sorted)) throw new Error('History contains a sequence gap')
  return sorted.slice(-MAX_VISIBLE_MESSAGES)
}

export function pageWindow(
  current: Message[],
  incoming: Message[],
  direction: Direction,
  sparse = false,
): Message[] {
  if (incoming.length === 0) return current
  const merged = mergeMessages(current, incoming)
  if (!sparse && !isContiguous(merged)) throw new Error('History contains a sequence gap')
  return direction === 'older'
    ? merged.slice(0, MAX_VISIBLE_MESSAGES)
    : merged.slice(-MAX_VISIBLE_MESSAGES)
}

export function appendLiveWindow(
  current: Message[],
  incoming: Message,
  browsingOlder: boolean,
  certifiedThrough?: string,
): Message[] {
  if (current.length === 0) return [incoming]
  const first = BigInt(current[0].sequence)
  const last = BigInt(current[current.length - 1].sequence)
  const sequence = BigInt(incoming.sequence)
  if (sequence < first || browsingOlder) return current
  const contiguousThrough = BigInt(certifiedThrough ?? last.toString())
  if (sequence > (contiguousThrough > last ? contiguousThrough : last) + 1n) return current
  return mergeMessages(current, [incoming]).slice(-MAX_VISIBLE_MESSAGES)
}

export function hasMoreNewer(window: Message[], latestSequence: string): boolean {
  return window.length > 0 && BigInt(window[window.length - 1].sequence) < BigInt(latestSequence)
}

export function hasUnresolvedGap(window: Message[], resolvedSequence: string): boolean {
  return window.length > 0 && BigInt(window[0].sequence) > BigInt(resolvedSequence) + 1n
}

export function historyAvailability(messages: Message[], latestSequence: string, baseline: string) {
  return {
    hasOlderMessages: Boolean(messages.length && BigInt(messages[0].sequence) > 1n),
    hasNewerMessages: hasMoreNewer(messages, latestSequence),
    hasUnresolvedGap: hasUnresolvedGap(messages, baseline),
  }
}
