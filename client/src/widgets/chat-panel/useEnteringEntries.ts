import { useEffect, useRef } from 'react'

const MAX_ANIMATED = 3
const NONE: ReadonlySet<string> = new Set()

export interface EntryKey {
  key: string
  saved: boolean
}

interface Rendered {
  chatId?: string
  keys: ReadonlySet<string>
  lastSaved?: string
  settled: boolean
}

export function useEnteringEntries(
  chatId: string | undefined,
  entries: EntryKey[],
  knownEmpty: boolean,
): ReadonlySet<string> {
  const rendered = useRef<Rendered>({ keys: NONE, settled: false })
  useEffect(() => {
    rendered.current = {
      chatId,
      keys: new Set(entries.map((entry) => entry.key)),
      lastSaved: entries.filter((entry) => entry.saved).at(-1)?.key,
      settled: entries.length > 0 || knownEmpty,
    }
  })
  const previous = rendered.current
  if (previous.chatId !== chatId || !previous.settled) return NONE
  const keys = entries.map((entry) => entry.key)
  const after = previous.lastSaved === undefined ? 0 : keys.indexOf(previous.lastSaved) + 1
  if (after === 0 && previous.lastSaved !== undefined) return NONE
  const added = keys.slice(after).filter((key) => !previous.keys.has(key))
  return added.length > 0 && added.length <= MAX_ANIMATED ? new Set(added) : NONE
}
