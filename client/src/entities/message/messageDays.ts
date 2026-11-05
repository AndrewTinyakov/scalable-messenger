import type { Message, PendingSend } from './model'

interface Entry {
  key: string
  message?: Message
  send?: PendingSend
}

export interface MessageDay<T extends Entry> {
  key: string
  timestamp: string
  entries: { entry: T; index: number }[]
}

export function groupByDay<T extends Entry>(entries: T[]): MessageDay<T>[] {
  const days: MessageDay<T>[] = []
  entries.forEach((entry, index) => {
    const timestamp = entry.send?.createdAt ?? entry.message?.createdAt ?? ''
    const key = new Date(timestamp).toDateString()
    const last = days.at(-1)
    if (last?.key === key) last.entries.push({ entry, index })
    else days.push({ key, timestamp, entries: [{ entry, index }] })
  })
  return days
}
