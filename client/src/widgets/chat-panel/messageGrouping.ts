import type { Message, PendingSend } from '../../entities/message/model'

const RUN_WINDOW_MS = 600000

interface Entry {
  message?: Message
  send?: PendingSend
}

function author(entry: Entry, userId: string) {
  return entry.message?.senderId ?? (entry.send ? userId : undefined)
}

export function sameMessageRun(left: Entry | undefined, right: Entry | undefined, userId: string) {
  if (!left || !right || author(left, userId) !== author(right, userId)) return false
  const before = new Date(left.send?.createdAt ?? left.message?.createdAt ?? '')
  const after = new Date(right.send?.createdAt ?? right.message?.createdAt ?? '')
  const gap = Math.abs(after.getTime() - before.getTime())
  return gap < RUN_WINDOW_MS && before.toDateString() === after.toDateString()
}
