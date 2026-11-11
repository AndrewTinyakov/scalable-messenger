import { useEffect, useRef } from 'react'

const MAX_ANIMATED = 3
const NONE: ReadonlySet<string> = new Set()

export interface EntryKey {
  key: string
  sequence?: string
  mine: boolean
}

interface Rendered {
  chatId?: string
  keys: ReadonlySet<string>
  pending: readonly string[]
  awaitingSaved: number
  newestSaved: bigint
  settled: boolean
  latest: boolean
}

const INITIAL: Rendered = {
  keys: NONE,
  pending: [],
  awaitingSaved: 0,
  newestSaved: 0n,
  settled: false,
  latest: true,
}

function arrivals(previous: Rendered, chatId: string | undefined, entries: EntryKey[]) {
  const sameChat = previous.chatId === chatId
  const keys = new Set(entries.map((entry) => entry.key))
  let awaitingSaved =
    (sameChat ? previous.awaitingSaved : 0) +
    (sameChat ? previous.pending.filter((key) => !keys.has(key)).length : 0)
  const added: string[] = []
  for (const entry of entries) {
    if (sameChat && previous.keys.has(entry.key)) continue
    if (entry.sequence !== undefined) {
      if (sameChat && BigInt(entry.sequence) <= previous.newestSaved) continue
      if (entry.mine && awaitingSaved > 0) {
        awaitingSaved -= 1
        continue
      }
    }
    added.push(entry.key)
  }
  return { added, awaitingSaved }
}

function newestSaved(entries: EntryKey[], floor: bigint): bigint {
  return entries.reduce(
    (newest, entry) =>
      entry.sequence !== undefined && BigInt(entry.sequence) > newest
        ? BigInt(entry.sequence)
        : newest,
    floor,
  )
}

export function useEnteringEntries(
  chatId: string | undefined,
  entries: EntryKey[],
  { knownEmpty, latest }: { knownEmpty: boolean; latest: boolean },
): ReadonlySet<string> {
  const rendered = useRef<Rendered>(INITIAL)
  useEffect(() => {
    const previous = rendered.current
    const sameChat = previous.chatId === chatId
    const newest = newestSaved(entries, sameChat ? previous.newestSaved : 0n)
    rendered.current = {
      chatId,
      keys: new Set(entries.map((entry) => entry.key)),
      pending: entries.filter((entry) => entry.sequence === undefined).map((entry) => entry.key),
      awaitingSaved: arrivals(previous, chatId, entries).awaitingSaved,
      newestSaved: newest,
      settled: newest > 0n || knownEmpty || (sameChat && previous.settled),
      latest,
    }
  })
  const previous = rendered.current
  if (previous.chatId !== chatId || !previous.settled || !previous.latest || !latest) return NONE
  const { added } = arrivals(previous, chatId, entries)
  return added.length > 0 && added.length <= MAX_ANIMATED ? new Set(added) : NONE
}
