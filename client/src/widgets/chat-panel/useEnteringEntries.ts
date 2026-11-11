import { useEffect, useRef } from 'react'

const MAX_ANIMATED = 3
const NONE: ReadonlySet<string> = new Set()

interface Rendered {
  chatId?: string
  keys: ReadonlySet<string>
  settled: boolean
}

export function useEnteringEntries(
  chatId: string | undefined,
  keys: string[],
  knownEmpty: boolean,
): ReadonlySet<string> {
  const rendered = useRef<Rendered>({ keys: NONE, settled: false })
  useEffect(() => {
    rendered.current = { chatId, keys: new Set(keys), settled: keys.length > 0 || knownEmpty }
  })
  const previous = rendered.current
  if (previous.chatId !== chatId || !previous.settled) return NONE
  const added = keys.filter((key) => !previous.keys.has(key))
  if (added.length === 0 || added.length > MAX_ANIMATED) return NONE
  const tail = new Set(keys.slice(-MAX_ANIMATED))
  return new Set(added.filter((key) => tail.has(key)))
}
