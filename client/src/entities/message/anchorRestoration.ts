import type { HistorySnapshot } from './historySnapshot'

export type AnchorPage = HistorySnapshot & {
  anchorMessageId: string | null
  hasOlder: boolean
  hasNewer: boolean
}

type Options = {
  initial: AnchorPage
  sequence: string
  newer(cursor: string): Promise<HistorySnapshot | undefined>
  older(cursor: string): Promise<HistorySnapshot | undefined>
  current(): boolean
  pause(): Promise<void>
}

export async function restoreAnchor({
  initial,
  sequence,
  newer,
  older,
  current,
  pause,
}: Options): Promise<AnchorPage | undefined> {
  const origin = BigInt(sequence)
  let best:
    | {
        page: HistorySnapshot
        id: string
        distance: bigint
        direction: 'initial' | 'older' | 'newer'
      }
    | undefined
  const anchor = initial.messages.find((row) => row.id === initial.anchorMessageId)
  if (anchor) {
    const delta = BigInt(anchor.sequence) - origin
    best = {
      page: initial,
      id: anchor.id,
      distance: delta < 0n ? -delta : delta,
      direction: 'initial',
    }
  }
  const consider = (page: HistorySnapshot, direction: 'initial' | 'older' | 'newer') => {
    for (const row of page.messages) {
      const delta = BigInt(row.sequence) - origin
      const distance = delta < 0n ? -delta : delta
      if (!best || distance < best.distance) best = { page, id: row.id, distance, direction }
    }
  }
  consider(initial, 'initial')
  if (best?.distance === 0n || (!initial.hasOlder && !initial.hasNewer))
    return best ? { ...initial, anchorMessageId: best.id } : initial
  if (initial.coverageAfterSequence === undefined || initial.coverageThroughSequence === undefined)
    throw new Error('History search did not provide a continuation')
  let before = BigInt(initial.coverageAfterSequence)
  let after = BigInt(initial.coverageThroughSequence)
  let hasOlder = initial.hasOlder
  let hasNewer = initial.hasNewer
  let foundOlder = false
  let foundNewer = false
  let latest: HistorySnapshot = initial
  let requests = 0
  while (current()) {
    const olderDistance = hasOlder ? (origin > before ? origin - before : 0n) : undefined
    const newerDistance = hasNewer ? (after + 1n > origin ? after + 1n - origin : 0n) : undefined
    if (
      best &&
      (olderDistance === undefined || olderDistance > best.distance) &&
      (newerDistance === undefined || newerDistance > best.distance)
    )
      return {
        ...best.page,
        anchorMessageId: best.id,
        hasOlder:
          best.direction === 'older'
            ? Boolean(best.page.hasMore)
            : hasOlder ||
              foundOlder ||
              (best.direction !== 'initial' && initial.messages.length > 0),
        hasNewer:
          best.direction === 'newer'
            ? Boolean(best.page.hasMore)
            : hasNewer ||
              foundNewer ||
              (best.direction !== 'initial' && initial.messages.length > 0),
      }
    if (!hasOlder && !hasNewer)
      return {
        ...latest,
        messages: [],
        anchorMessageId: null,
        coverageAfterSequence: before.toString(),
        coverageThroughSequence: after.toString(),
        hasOlder: false,
        hasNewer: false,
      }
    if (requests === 8) {
      await pause()
      requests = 0
      if (!current()) return undefined
    }
    const direction =
      olderDistance !== undefined && (newerDistance === undefined || olderDistance <= newerDistance)
        ? 'older'
        : 'newer'
    const page =
      direction === 'older' ? await older((before + 1n).toString()) : await newer(after.toString())
    requests += 1
    if (!current()) return undefined
    if (!page) continue
    if (page.coverageAfterSequence === undefined || page.coverageThroughSequence === undefined)
      throw new Error('History search did not provide a continuation')
    latest = page
    if (direction === 'older') {
      const next = BigInt(page.coverageAfterSequence)
      if (page.hasMore && next >= before) throw new Error('Older history search did not advance')
      before = next
      hasOlder = Boolean(page.hasMore)
      foundOlder ||= page.messages.length > 0
    } else {
      const next = BigInt(page.coverageThroughSequence)
      if (page.hasMore && next <= after) throw new Error('Newer history search did not advance')
      after = next
      hasNewer = Boolean(page.hasMore)
      foundNewer ||= page.messages.length > 0
    }
    consider(page, direction)
  }
  return undefined
}
