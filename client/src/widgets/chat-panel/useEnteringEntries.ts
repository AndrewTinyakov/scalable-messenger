import { useEffect, useRef } from 'react'

const MAX_ANIMATED = 3
const NONE: ReadonlySet<string> = new Set()

interface Rendered {
  chatId?: string
  keys: ReadonlySet<string>
  last?: string
  settled: boolean
}

export function useEnteringEntries(
  chatId: string | undefined,
  keys: string[],
  knownEmpty: boolean,
): ReadonlySet<string> {
  const rendered = useRef<Rendered>({ keys: NONE, settled: false })
  useEffect(() => {
    rendered.current = {
      chatId,
      keys: new Set(keys),
      last: keys.at(-1),
      settled: keys.length > 0 || knownEmpty,
    }
  })
  const previous = rendered.current
  if (previous.chatId !== chatId || !previous.settled) return NONE
  const after = previous.last === undefined ? 0 : keys.indexOf(previous.last) + 1
  if (after === 0 && previous.last !== undefined) return NONE
  const added = keys.slice(after).filter((key) => !previous.keys.has(key))
  return added.length > 0 && added.length <= MAX_ANIMATED ? new Set(added) : NONE
}
