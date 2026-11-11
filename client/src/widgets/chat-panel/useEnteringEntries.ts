import { useEffect, useRef } from 'react'

const MAX_ANIMATED = 3
const NONE: ReadonlySet<string> = new Set()

export interface EntryKey {
  key: string
  sequence?: string
}

interface Rendered {
  chatId?: string
  keys: ReadonlySet<string>
  newestSaved: bigint
  settled: boolean
  latest: boolean
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
  const rendered = useRef<Rendered>({ keys: NONE, newestSaved: 0n, settled: false, latest })
  useEffect(() => {
    const previous = rendered.current
    const sameChat = previous.chatId === chatId
    const newest = newestSaved(entries, sameChat ? previous.newestSaved : 0n)
    rendered.current = {
      chatId,
      keys: new Set(entries.map((entry) => entry.key)),
      newestSaved: newest,
      settled: newest > 0n || knownEmpty || (sameChat && previous.settled),
      latest,
    }
  })
  const previous = rendered.current
  if (previous.chatId !== chatId || !previous.settled || !previous.latest || !latest) return NONE
  const added = entries.filter(
    (entry) =>
      !previous.keys.has(entry.key) &&
      (entry.sequence === undefined || BigInt(entry.sequence) > previous.newestSaved),
  )
  return added.length > 0 && added.length <= MAX_ANIMATED
    ? new Set(added.map((entry) => entry.key))
    : NONE
}
