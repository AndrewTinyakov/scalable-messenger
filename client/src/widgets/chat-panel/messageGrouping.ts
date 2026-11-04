import type { Message, PendingSend } from '../../entities/message/model'

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
  const gap = after.getTime() - before.getTime()
  return gap >= 0 && gap < 600000 && before.toDateString() === after.toDateString()
}
