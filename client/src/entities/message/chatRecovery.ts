import type { Message } from './model'
import {
  advanceAppliedSequence, appendLiveWindow, hasMoreNewer, hasNewAppliedMessages, historyBoundaryBefore,
  MAX_CATCH_UP_MESSAGES, pageWindow, replaceWindow,
} from './historyWindow'

type CursorMap = Record<string, string>
type MessageMap = Record<string, Message[]>
type RoomCursor = { epoch: string; streamId: string }
type RoomCursorMap = Record<string, RoomCursor>

const browserStorage: Pick<Storage, 'getItem' | 'setItem'> = {
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
}

export type RecoveryFrame =
  | { type: 'dismissed'; version: 1; chatId: string; sequence: string }
  | { type: 'applied'; version: 1; chatId: string; sequence: string; epoch?: string; streamId?: string }

function readStored<T>(storage: Pick<Storage, 'getItem'>, key: string, fallback: T): T {
  try {
    const value = storage.getItem(key)
    return value ? JSON.parse(value) as T : fallback
  } catch {
    return fallback
  }
}

function writeStored(storage: Pick<Storage, 'setItem'>, key: string, value: unknown) {
  try { storage.setItem(key, JSON.stringify(value)) } catch { /* Storage may be full or disabled. */ }
}

function newerStreamId(next: string, current: string): boolean {
  const [nextTime, nextSequence] = next.split('-').map(BigInt)
  const [currentTime, currentSequence] = current.split('-').map(BigInt)
  return nextTime > currentTime || (nextTime === currentTime && nextSequence > currentSequence)
}

/** Owns a device's chat recovery baseline and the ordering of its socket acknowledgements. */
export class ChatRecovery {
  private windows: MessageMap = {}
  private detachedWindows = new Set<string>()
  private resolved: CursorMap
  private dismissedThrough: CursorMap
  private roomCursors: RoomCursorMap
  private latest: CursorMap = {}
  private deferredGaps = new Set<string>()

  constructor(private readonly prefix: string, private readonly storage: Pick<Storage, 'getItem' | 'setItem'> = browserStorage) {
    // Older cursor keys could skip unseen history, so they are not migrated.
    this.resolved = readStored(storage, `${prefix}.resolved-cursor.v2`, {})
    this.dismissedThrough = readStored(storage, `${prefix}.dismissed-through.v2`, {})
    this.roomCursors = readStored(storage, `${prefix}.room-cursor.v2`, {})
  }

  baseline(chatId: string): string { return this.resolved[chatId] || '0' }
  window(chatId: string): Message[] { return this.windows[chatId] || [] }
  visibleWindows(): MessageMap { return { ...this.windows } }
  isDetached(chatId: string): boolean { return this.detachedWindows.has(chatId) }

  compactWindows(selectedId: string | null): void {
    this.windows = Object.fromEntries(Object.entries(this.windows).map(([id, items]) => [id, id === selectedId ? items : items.slice(-1)]))
  }
  latestSequence(chatId: string): string { return this.latest[chatId] || '0' }
  latestSequences(): CursorMap { return { ...this.latest } }
  hasBaseline(chatId: string): boolean { return Boolean(this.resolved[chatId]) }

  recordLatest(chatId: string, sequence: string): boolean {
    if (BigInt(sequence) <= BigInt(this.latestSequence(chatId))) return false
    this.latest = { ...this.latest, [chatId]: sequence }
    return true
  }

  apply(chatId: string, messages: Message[]): void {
    const current = this.baseline(chatId)
    const next = advanceAppliedSequence(current, messages)
    if (next === current) return
    this.resolved = { ...this.resolved, [chatId]: next }
    writeStored(this.storage, `${this.prefix}.resolved-cursor.v2`, this.resolved)
    if (BigInt(next) >= BigInt(this.latestSequence(chatId))) this.deferredGaps.delete(chatId)
  }

  receive(chatId: string, incoming: Message[], selected: boolean, readingHistory: boolean): boolean {
    if (!incoming.length) return false
    const browsingOlder = selected && (this.isDetached(chatId) || readingHistory)
    let visible = this.window(chatId)
    const incorporated: Message[] = []
    for (const message of incoming) {
      const next = selected
        ? appendLiveWindow(visible, message, browsingOlder)
        : !visible.length || BigInt(message.sequence) >= BigInt(visible.at(-1)!.sequence) ? [message] : visible
      if (next !== visible) incorporated.push(message)
      visible = next
    }
    const highest = incoming.reduce((value, message) => BigInt(message.sequence) > BigInt(value) ? message.sequence : value, '0')
    const latestChanged = this.recordLatest(chatId, highest)
    this.windows = { ...this.windows, [chatId]: visible }
    this.apply(chatId, incorporated)
    return latestChanged
  }

  latestPage(chatId: string, incoming: Message[], moveViewport: boolean, initialize: boolean, room: string): {
    latest?: string; messages: Message[]; replaced: boolean; latestChanged: boolean; dismissal: RecoveryFrame | null
  } {
    const visible = replaceWindow(incoming)
    const current = this.window(chatId)
    const fetchedLatest = incoming.at(-1)?.sequence
    const currentLatest = current.at(-1)?.sequence
    const keepNewerCurrent = Boolean(currentLatest && fetchedLatest && BigInt(currentLatest) > BigInt(fetchedLatest))
    const shown = keepNewerCurrent ? current : visible
    const replaced = (moveViewport || current.length === 0) && !keepNewerCurrent
    if (replaced) {
      this.windows = { ...this.windows, [chatId]: visible }
      this.detachedWindows.delete(chatId)
    }
    const latest = keepNewerCurrent ? currentLatest : fetchedLatest
    const latestChanged = latest ? this.recordLatest(chatId, latest) : false
    let dismissal: RecoveryFrame | null = null
    if (initialize && !this.hasBaseline(chatId) && shown.length) {
      const boundary = historyBoundaryBefore(shown)
      if (BigInt(boundary) > 0n) dismissal = this.dismiss(chatId, boundary, room)
    }
    if (replaced || initialize) this.apply(chatId, shown)
    if (latest && BigInt(latest) > BigInt(this.baseline(chatId))) this.deferGap(chatId)
    return { latest: shown.at(-1)?.sequence, messages: shown, replaced, latestChanged, dismissal }
  }

  page(chatId: string, incoming: Message[], direction: 'older' | 'newer', hasMore = false): boolean {
    const current = this.window(chatId)
    const visible = pageWindow(current, incoming, direction)
    if (direction === 'older' && visible.at(-1)?.sequence !== current.at(-1)?.sequence) this.detachedWindows.add(chatId)
    this.windows = { ...this.windows, [chatId]: visible }
    this.apply(chatId, visible)
    if (direction === 'older') return false
    const end = incoming.at(-1)?.sequence
    const latestChanged = end ? this.recordLatest(chatId, hasMore ? (BigInt(end) + 1n).toString() : end) : false
    if (!hasMoreNewer(visible, this.latestSequence(chatId))) this.detachedWindows.delete(chatId)
    return latestChanged
  }

  jumpToLatest(chatId: string, messages: Message[], room: string): RecoveryFrame | null {
    const dismissal = this.dismiss(chatId, historyBoundaryBefore(messages), room)
    this.apply(chatId, messages)
    return dismissal
  }

  dismiss(chatId: string, sequence: string, room: string): RecoveryFrame | null {
    if (BigInt(sequence) <= BigInt(this.baseline(chatId))) return null
    this.dismissedThrough = { ...this.dismissedThrough, [chatId]: sequence }
    this.resolved = { ...this.resolved, [chatId]: sequence }
    writeStored(this.storage, `${this.prefix}.dismissed-through.v2`, this.dismissedThrough)
    writeStored(this.storage, `${this.prefix}.resolved-cursor.v2`, this.resolved)
    this.deferredGaps.delete(chatId)
    const { [room]: _discarded, ...remaining } = this.roomCursors
    this.roomCursors = remaining
    writeStored(this.storage, `${this.prefix}.room-cursor.v2`, remaining)
    return { type: 'dismissed', version: 1, chatId, sequence }
  }

  subscription(chatId: string, room: string): { lastAppliedSequence: string; epoch?: string; streamId?: string } {
    return { lastAppliedSequence: this.baseline(chatId), ...(this.roomCursors[room] || {}) }
  }

  dismissalFrame(chatId: string): RecoveryFrame | null {
    const sequence = this.dismissedThrough[chatId]
    return sequence ? { type: 'dismissed', version: 1, chatId, sequence } : null
  }

  deferGap(chatId: string): void { this.deferredGaps.add(chatId) }
  hasDeferredGap(chatId: string): boolean { return this.deferredGaps.has(chatId) }
  shouldFetchLatest(chatId: string): boolean {
    return this.hasDeferredGap(chatId) || BigInt(this.latestSequence(chatId)) - BigInt(this.baseline(chatId)) > BigInt(MAX_CATCH_UP_MESSAGES)
  }

  liveMessage(chatId: string, sequence: string): { incorporate: boolean; catchUp: boolean } {
    const incoming = BigInt(sequence)
    return {
      incorporate: incoming > BigInt(this.dismissedThrough[chatId] || '0'),
      catchUp: incoming > BigInt(this.baseline(chatId)) + 1n && !this.hasDeferredGap(chatId),
    }
  }

  appliedSince(chatId: string, before: string): RecoveryFrame | null {
    const sequence = this.resolved[chatId]
    return sequence && hasNewAppliedMessages(before, sequence, this.dismissedThrough[chatId] || '0')
      ? { type: 'applied', version: 1, chatId, sequence }
      : null
  }

  acknowledgeLive(chatId: string, sequence: string, room: string, epoch?: string, streamId?: string): RecoveryFrame | null {
    if (BigInt(sequence) <= BigInt(this.dismissedThrough[chatId] || '0')) return null
    if (BigInt(sequence) > BigInt(this.baseline(chatId))) return null
    if (epoch && streamId) {
      const previous = this.roomCursors[room]
      if (!previous || previous.epoch !== epoch || newerStreamId(streamId, previous.streamId)) {
        this.roomCursors = { ...this.roomCursors, [room]: { epoch, streamId } }
        writeStored(this.storage, `${this.prefix}.room-cursor.v2`, this.roomCursors)
      }
    }
    return { type: 'applied', version: 1, chatId, sequence: this.baseline(chatId), ...(epoch && streamId ? { epoch, streamId } : {}) }
  }

  forget(chatId: string): void {
    const { [chatId]: _window, ...windows } = this.windows
    const { [chatId]: _resolved, ...resolved } = this.resolved
    const { [chatId]: _dismissed, ...dismissed } = this.dismissedThrough
    const { [chatId]: _latest, ...latest } = this.latest
    const { [`group:${chatId}`]: _room, ...rooms } = this.roomCursors
    this.resolved = resolved
    this.dismissedThrough = dismissed
    this.latest = latest
    this.windows = windows
    this.detachedWindows.delete(chatId)
    this.roomCursors = rooms
    this.deferredGaps.delete(chatId)
    writeStored(this.storage, `${this.prefix}.resolved-cursor.v2`, resolved)
    writeStored(this.storage, `${this.prefix}.dismissed-through.v2`, dismissed)
    writeStored(this.storage, `${this.prefix}.room-cursor.v2`, rooms)
  }
}
