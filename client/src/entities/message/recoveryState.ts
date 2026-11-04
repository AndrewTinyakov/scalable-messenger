import { FrameType } from '../../shared/api/generated/socket-vocabulary'
import { groupRoom, type RecoveryFrame } from '../../shared/api/socket'
import { isRecord, isSequence, isStreamId } from '../../shared/lib/validation'
import {
  advanceAppliedSequence,
  appendLiveWindow,
  hasMoreNewer,
  hasNewAppliedMessages,
  historyBoundaryBefore,
  isContiguous,
  MAX_CATCH_UP_MESSAGES,
  pageWindow,
  replaceWindow,
} from './historyWindow'
import { mergeMessages, type Message } from './model'
import type { RecoveryBatch } from './recoveryBatch'

type CursorMap = Record<string, string>
type MessageMap = Record<string, Message[]>
type RoomCursorMap = Record<string, { epoch: string; streamId: string }>

function readStored(storage: Pick<Storage, 'getItem'>, key: string): Record<string, unknown> {
  try {
    const value = storage.getItem(key)
    const parsed: unknown = value ? JSON.parse(value) : null
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function readSequences(storage: Pick<Storage, 'getItem'>, key: string): CursorMap {
  return Object.fromEntries(
    Object.entries(readStored(storage, key)).flatMap(([chatId, sequence]) =>
      isSequence(sequence) ? [[chatId, sequence]] : [],
    ),
  )
}

function readRoomCursors(storage: Pick<Storage, 'getItem'>, key: string): RoomCursorMap {
  return Object.fromEntries(
    Object.entries(readStored(storage, key)).flatMap(([room, cursor]) =>
      isRecord(cursor) &&
      typeof cursor.epoch === 'string' &&
      cursor.epoch.length > 0 &&
      isStreamId(cursor.streamId)
        ? [[room, { epoch: cursor.epoch, streamId: cursor.streamId }]]
        : [],
    ),
  )
}

function newerStreamId(next: string, current: string): boolean {
  const [nextTime, nextSequence] = next.split('-').map(BigInt)
  const [currentTime, currentSequence] = current.split('-').map(BigInt)
  return nextTime > currentTime || (nextTime === currentTime && nextSequence > currentSequence)
}

export class RecoveryState {
  private windows: MessageMap = {}
  private pinned: MessageMap = {}
  private selectedChatId: string | null = null
  private detachedWindows = new Set<string>()
  private resolved: CursorMap
  private dismissedThrough: CursorMap
  private roomCursors: RoomCursorMap
  private latest: CursorMap = {}
  private deferredGaps = new Set<string>()
  private historyBuffered: MessageMap = {}

  constructor(
    private readonly prefix: string,
    storage: Pick<Storage, 'getItem'>,
    private readonly batch: RecoveryBatch,
  ) {
    this.resolved = readSequences(storage, `${prefix}.resolved-cursor.v2`)
    this.dismissedThrough = readSequences(storage, `${prefix}.dismissed-through.v2`)
    this.roomCursors = readRoomCursors(storage, `${prefix}.room-cursor.v2`)
  }

  clearHistoryBuffer(chatId: string): void {
    delete this.historyBuffered[chatId]
  }
  hasHistoryGap(chatId: string): boolean {
    return Boolean(this.historyBuffered[chatId]?.length) && !this.hasDeferredGap(chatId)
  }

  baseline(chatId: string): string {
    return this.resolved[chatId] || '0'
  }
  window(chatId: string): Message[] {
    return this.windows[chatId] || []
  }
  retains(chatId: string, messageId: string): boolean {
    return [
      this.window(chatId),
      this.pinned[chatId] ?? [],
      this.historyBuffered[chatId] ?? [],
    ].some((items) => items.some((message) => message.id === messageId))
  }
  visibleWindows(): MessageMap {
    return { ...this.windows }
  }
  isDetached(chatId: string): boolean {
    return this.detachedWindows.has(chatId)
  }

  latestWindows(): MessageMap {
    return { ...this.windows, ...this.pinned }
  }

  installAround(chatId: string, incoming: Message[]): void {
    const known = mergeMessages(this.window(chatId), this.pinned[chatId] ?? [])
    this.windows = {
      ...this.windows,
      [chatId]: replaceWindow(
        mergeMessages(
          incoming,
          known.filter((message) => incoming.some((item) => item.id === message.id)),
        ),
      ),
    }
    this.detachedWindows.add(chatId)
  }

  patch(chatId: string, incoming: Message[]): void {
    const patch = (items: Message[]) => {
      const ids = new Set(items.map((message) => message.id))
      const merged = mergeMessages(items, incoming)
      return merged.filter((message) => ids.has(message.id))
    }
    this.windows = { ...this.windows, [chatId]: patch(this.window(chatId)) }
    if (this.pinned[chatId]) this.pinned[chatId] = patch(this.pinned[chatId])
    if (this.historyBuffered[chatId])
      this.historyBuffered[chatId] = patch(this.historyBuffered[chatId])
  }

  returnToPinned(chatId: string): boolean {
    const latest = this.pinned[chatId]
    if (!latest?.length) return false
    this.windows = { ...this.windows, [chatId]: latest }
    this.detachedWindows.delete(chatId)
    return true
  }

  private boundWindows(): void {
    const inactive = Object.entries(this.windows)
      .filter(([id]) => id !== this.selectedChatId)
      .slice(-100)
    this.windows = {
      ...Object.fromEntries(inactive),
      ...(this.selectedChatId && this.windows[this.selectedChatId]
        ? { [this.selectedChatId]: this.windows[this.selectedChatId] }
        : {}),
    }
  }

  compactWindows(selectedId: string | null): void {
    this.selectedChatId = selectedId
    this.pinned = Object.fromEntries(
      Object.entries(this.pinned).filter(([id]) => id === selectedId),
    )
    for (const id of this.detachedWindows) if (id !== selectedId) this.detachedWindows.delete(id)
    this.windows = Object.fromEntries(
      Object.entries(this.windows).map(([id, items]) => [
        id,
        id === selectedId ? items : items.slice(-1),
      ]),
    )
    this.boundWindows()
  }
  private latestSequence(chatId: string): string {
    return this.latest[chatId] || '0'
  }
  latestSequences(): CursorMap {
    return { ...this.latest }
  }
  hasBaseline(chatId: string): boolean {
    return Boolean(this.resolved[chatId])
  }

  recordLatest(chatId: string, sequence: string): boolean {
    if (BigInt(sequence) <= BigInt(this.latestSequence(chatId))) return false
    this.latest = { ...this.latest, [chatId]: sequence }
    return true
  }

  private apply(chatId: string, messages: Message[], batch = false): void {
    const current = this.baseline(chatId)
    const next = advanceAppliedSequence(current, messages)
    if (next === current) return
    this.resolved = { ...this.resolved, [chatId]: next }
    this.batch.persist(`${this.prefix}.resolved-cursor.v2`, this.resolved, batch)
    if (BigInt(next) >= BigInt(this.latestSequence(chatId))) this.deferredGaps.delete(chatId)
  }

  receive(
    chatId: string,
    incoming: Message[],
    selected: boolean,
    readingHistory: boolean,
  ): boolean {
    if (!incoming.length) return false
    const incomingIds = new Set(incoming.map((message) => message.id))
    incoming = mergeMessages(
      mergeMessages(this.window(chatId), this.pinned[chatId] ?? []),
      incoming,
    ).filter((message) => incomingIds.has(message.id))
    if (selected) this.selectedChatId = chatId
    const browsingOlder = selected && (this.isDetached(chatId) || readingHistory)
    let visible = this.window(chatId)
    const incorporated: Message[] = []
    for (const message of incoming) {
      const next = selected
        ? appendLiveWindow(visible, message, browsingOlder)
        : !visible.length || BigInt(message.sequence) >= BigInt(visible.at(-1)!.sequence)
          ? mergeMessages(visible, [message]).slice(-1)
          : visible
      if (next !== visible) incorporated.push(message)
      visible = next
    }
    let pinned = this.pinned[chatId] ?? (selected ? this.window(chatId).slice(-50) : [])
    for (const message of incoming) pinned = appendLiveWindow(pinned, message, false).slice(-50)
    if (selected && pinned.length) this.pinned[chatId] = pinned
    if (browsingOlder) this.apply(chatId, pinned, true)
    const highest = incoming.reduce(
      (value, message) => (BigInt(message.sequence) > BigInt(value) ? message.sequence : value),
      '0',
    )
    const latestChanged = this.recordLatest(chatId, highest)
    this.windows = { ...this.windows, [chatId]: visible }
    this.boundWindows()
    this.apply(chatId, incorporated, true)
    return latestChanged
  }

  latestPage(
    chatId: string,
    incoming: Message[],
    moveViewport: boolean,
    initialize: boolean,
    room: string,
    selected = true,
  ): {
    latest?: string
    messages: Message[]
    replaced: boolean
    latestChanged: boolean
    dismissal: RecoveryFrame | null
  } {
    const retained = mergeMessages(this.window(chatId), this.pinned[chatId] ?? [])
    const visible = replaceWindow(
      mergeMessages(
        incoming,
        retained.filter((message) => incoming.some((item) => item.id === message.id)),
      ),
    )
    const previousPin = this.pinned[chatId] ?? []
    const mergedPin = mergeMessages(visible, previousPin)
    if (selected)
      this.pinned[chatId] = isContiguous(mergedPin)
        ? mergedPin.slice(-50)
        : BigInt(previousPin.at(-1)?.sequence ?? '0') > BigInt(visible.at(-1)?.sequence ?? '0')
          ? previousPin
          : visible.slice(-50)
    const current = this.window(chatId)
    const fetchedLatest = incoming.at(-1)?.sequence
    const currentLatest = current.at(-1)?.sequence
    const keepNewerCurrent = Boolean(
      currentLatest && fetchedLatest && BigInt(currentLatest) > BigInt(fetchedLatest),
    )
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

  page(
    chatId: string,
    incoming: Message[],
    direction: 'older' | 'newer',
    hasMore = false,
  ): boolean {
    const current = this.window(chatId)
    const visible = pageWindow(current, incoming, direction)
    if (direction === 'older' && visible.at(-1)?.sequence !== current.at(-1)?.sequence)
      this.detachedWindows.add(chatId)
    this.windows = { ...this.windows, [chatId]: visible }
    this.apply(chatId, visible)
    if (direction === 'older') return false
    const end = incoming.at(-1)?.sequence
    const latestChanged = end
      ? this.recordLatest(chatId, hasMore ? (BigInt(end) + 1n).toString() : end)
      : false
    if (!hasMoreNewer(visible, this.latestSequence(chatId))) this.detachedWindows.delete(chatId)
    return latestChanged
  }

  jumpToLatest(chatId: string, messages: Message[], room: string): RecoveryFrame | null {
    const dismissal = this.dismiss(chatId, historyBoundaryBefore(messages), room)
    this.apply(chatId, messages)
    return dismissal
  }

  private dismiss(chatId: string, sequence: string, room: string): RecoveryFrame | null {
    if (BigInt(sequence) <= BigInt(this.baseline(chatId))) return null
    this.batch.discard(chatId)
    this.dismissedThrough = { ...this.dismissedThrough, [chatId]: sequence }
    this.resolved = { ...this.resolved, [chatId]: sequence }
    this.batch.persist(`${this.prefix}.dismissed-through.v2`, this.dismissedThrough)
    this.batch.persist(`${this.prefix}.resolved-cursor.v2`, this.resolved)
    this.deferredGaps.delete(chatId)
    const { [room]: _discarded, ...remaining } = this.roomCursors
    this.roomCursors = remaining
    this.batch.persist(`${this.prefix}.room-cursor.v2`, remaining)
    return { type: FrameType.DISMISSED, version: 1, chatId, sequence }
  }

  subscription(
    chatId: string,
    room: string,
  ): { lastAppliedSequence: string; epoch?: string; streamId?: string } {
    return { lastAppliedSequence: this.baseline(chatId), ...(this.roomCursors[room] || {}) }
  }

  dismissalFrame(chatId: string): RecoveryFrame | null {
    const sequence = this.dismissedThrough[chatId]
    return sequence ? { type: FrameType.DISMISSED, version: 1, chatId, sequence } : null
  }

  deferGap(chatId: string): void {
    this.deferredGaps.add(chatId)
  }
  private hasDeferredGap(chatId: string): boolean {
    return this.deferredGaps.has(chatId)
  }
  shouldFetchLatest(chatId: string): boolean {
    return (
      this.hasDeferredGap(chatId) ||
      BigInt(this.latestSequence(chatId)) - BigInt(this.baseline(chatId)) >
        BigInt(MAX_CATCH_UP_MESSAGES)
    )
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
      ? { type: FrameType.APPLIED, version: 1, chatId, sequence }
      : null
  }

  acknowledgeLive(
    chatId: string,
    sequence: string,
    room: string,
    epoch?: string,
    streamId?: string,
  ): RecoveryFrame | null {
    if (BigInt(sequence) <= BigInt(this.dismissedThrough[chatId] || '0')) return null
    if (BigInt(sequence) > BigInt(this.baseline(chatId))) return null
    if (epoch && streamId) {
      const previous = this.roomCursors[room]
      if (!previous || previous.epoch !== epoch || newerStreamId(streamId, previous.streamId)) {
        this.roomCursors = { ...this.roomCursors, [room]: { epoch, streamId } }
        this.batch.persist(`${this.prefix}.room-cursor.v2`, this.roomCursors, true)
      }
    }
    return {
      type: FrameType.APPLIED,
      version: 1,
      chatId,
      sequence: this.baseline(chatId),
      ...(epoch && streamId ? this.roomCursors[room] : {}),
    }
  }

  forget(chatId: string): void {
    this.batch.discard(chatId)
    const { [chatId]: _window, ...windows } = this.windows
    const { [chatId]: _resolved, ...resolved } = this.resolved
    const { [chatId]: _dismissed, ...dismissed } = this.dismissedThrough
    const { [chatId]: _latest, ...latest } = this.latest
    const { [groupRoom(chatId)]: _room, ...rooms } = this.roomCursors
    this.resolved = resolved
    this.dismissedThrough = dismissed
    this.latest = latest
    this.windows = windows
    delete this.pinned[chatId]
    this.detachedWindows.delete(chatId)
    this.roomCursors = rooms
    this.deferredGaps.delete(chatId)
    delete this.historyBuffered[chatId]
    this.batch.persist(`${this.prefix}.resolved-cursor.v2`, resolved)
    this.batch.persist(`${this.prefix}.dismissed-through.v2`, dismissed)
    this.batch.persist(`${this.prefix}.room-cursor.v2`, rooms)
  }

  incorporateHistory(chatId: string, incoming: Message[], selected: boolean): void {
    if (!incoming.length) return
    const buffered = mergeMessages(this.historyBuffered[chatId] || [], incoming)
    const merged = mergeMessages(this.window(chatId), buffered)
    this.recordLatest(chatId, incoming.at(-1)!.sequence)
    if (!isContiguous(merged)) {
      this.historyBuffered[chatId] = buffered
      return
    }
    delete this.historyBuffered[chatId]
    this.windows = {
      ...this.windows,
      [chatId]: selected ? pageWindow(this.window(chatId), buffered, 'newer') : merged.slice(-1),
    }
    this.apply(chatId, merged)
  }
}
