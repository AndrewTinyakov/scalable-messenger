import { FrameType } from '../../shared/api/generated/socket-vocabulary'
import { groupRoom, type RecoveryFrame } from '../../shared/api/socket'
import { isRecord, isSequence, isStreamId } from '../../shared/lib/validation'
import { hasCoverage, type HistorySnapshot, type SnapshotMetadata } from './historySnapshot'
import { HistoryVisibility } from './historyVisibility'
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
  private readonly visibility = new HistoryVisibility((chatId) => this.evictWindow(chatId))

  private evictWindow(chatId: string): void {
    const { [chatId]: _window, ...windows } = this.windows
    this.windows = windows
    delete this.pinned[chatId]
    delete this.historyBuffered[chatId]
    this.detachedWindows.delete(chatId)
  }

  private cutoff(chatId: string): bigint {
    return this.visibility.cutoff(chatId)
  }

  eligible(message: Pick<Message, 'chatId' | 'sequence'>): boolean {
    return BigInt(message.sequence) > this.cutoff(message.chatId)
  }

  requiresResolution(message: Message): boolean {
    if (BigInt(message.sequence) <= BigInt(this.baseline(message.chatId))) return false
    if (this.visibility.snapshot(message.chatId).snapshotSequence === undefined) return true
    return (
      BigInt(message.sequence) > BigInt(this.baseline(message.chatId)) &&
      BigInt(message.sequence) <=
        BigInt(this.visibility.snapshot(message.chatId).snapshotSequence ?? '0') &&
      (!this.retains(message.chatId, message.id) ||
        this.visibility.isUnverified(message.chatId, message.id))
    )
  }

  hydrateReply(message: Message): Message | undefined {
    if (!message.replyToMessageId) return message
    if (this.visibility.isUnverified(message.chatId, message.replyToMessageId)) return undefined
    if (message.replySenderId != null) return message
    const target = [this.window(message.chatId), this.pinned[message.chatId] ?? []]
      .flat()
      .find((row) => row.id === message.replyToMessageId)
    if (!target || !this.eligible(target)) return undefined
    return {
      ...message,
      replySenderId: target.senderId,
      replyBody: target.deletedAt ? '' : [...target.body].slice(0, 160).join(''),
      replyDeleted: Boolean(target.deletedAt),
      replyVersion: target.messageVersion ?? '1',
    }
  }

  retainedIds(chatId: string): string[] {
    return [
      ...new Set(
        [
          this.window(chatId),
          this.pinned[chatId] ?? [],
          this.historyBuffered[chatId] ?? [],
        ].flatMap((items) =>
          items.flatMap((message) =>
            message.replyToMessageId ? [message.id, message.replyToMessageId] : [message.id],
          ),
        ),
      ),
    ].slice(0, 500)
  }

  private filterWindows(
    chatId: string,
    keep: (message: Message) => boolean,
    absent = new Set<string>(),
  ): void {
    const filter = (items: Message[]) =>
      items.filter(keep).map((message) =>
        message.replyToMessageId && absent.has(message.replyToMessageId)
          ? {
              ...message,
              replySenderId: null,
              replyBody: null,
              replyDeleted: null,
              replyVersion: null,
            }
          : message,
      )
    this.windows = { ...this.windows, [chatId]: filter(this.window(chatId)) }
    if (this.pinned[chatId]) this.pinned[chatId] = filter(this.pinned[chatId])
    if (this.historyBuffered[chatId])
      this.historyBuffered[chatId] = filter(this.historyBuffered[chatId])
  }

  /** Shows quotes of a message the server no longer returns as unavailable. */
  quoteTargetGone(chatId: string, messageId: string): void {
    this.filterWindows(chatId, () => true, new Set([messageId]))
  }

  observeSnapshot(chatId: string, snapshot: Partial<SnapshotMetadata>): void {
    const previousCutoff = this.cutoff(chatId)
    const ids = this.retainedIds(chatId)
    if (this.visibility.observe(chatId, snapshot, ids))
      this.filterWindows(chatId, () => true, new Set(ids))
    if (this.cutoff(chatId) > previousCutoff) {
      const absent = new Set(
        [this.window(chatId), this.pinned[chatId] ?? [], this.historyBuffered[chatId] ?? []]
          .flat()
          .filter((message) => !this.eligible(message))
          .map((message) => message.id),
      )
      this.filterWindows(chatId, (message) => this.eligible(message), absent)
    }
    if (snapshot.snapshotSequence) this.recordLatest(chatId, snapshot.snapshotSequence)
  }

  reconcileSnapshot(chatId: string, page: HistorySnapshot): void {
    this.observeSnapshot(chatId, page)
    if (!hasCoverage(page)) return
    const ids = new Set(page.messages.map((message) => message.id))
    const inside = (message: Message) =>
      BigInt(message.sequence) > BigInt(page.coverageAfterSequence) &&
      BigInt(message.sequence) <= BigInt(page.coverageThroughSequence)
    const absent = new Set(
      [this.window(chatId), this.pinned[chatId] ?? [], this.historyBuffered[chatId] ?? []]
        .flat()
        .filter((message) => inside(message) && !ids.has(message.id))
        .map((message) => message.id),
    )
    this.filterWindows(chatId, (message) => !inside(message) || ids.has(message.id), absent)
  }

  resolve(chatId: string, ids: string[], page: HistorySnapshot): void {
    this.observeSnapshot(chatId, page)
    const returned = new Set(page.messages.map((message) => message.id))
    const requested = new Set(ids)
    const absent = new Set(ids.filter((id) => !returned.has(id)))
    this.visibility.resolved(chatId, ids)
    this.filterWindows(
      chatId,
      (message) => !requested.has(message.id) || returned.has(message.id),
      absent,
    )
    const replace = (items: Message[]) =>
      items.map((message) => page.messages.find((next) => next.id === message.id) ?? message)
    this.windows = { ...this.windows, [chatId]: replace(this.window(chatId)) }
    if (this.pinned[chatId]) this.pinned[chatId] = replace(this.pinned[chatId])
    if (this.historyBuffered[chatId])
      this.historyBuffered[chatId] = replace(this.historyBuffered[chatId])
  }

  certify(chatId: string, page: HistorySnapshot): void {
    if (!hasCoverage(page) || BigInt(page.coverageAfterSequence) > BigInt(this.baseline(chatId)))
      return
    if (BigInt(page.coverageThroughSequence) <= BigInt(this.baseline(chatId))) return
    this.resolved = { ...this.resolved, [chatId]: page.coverageThroughSequence }
    this.batch.persist(`${this.prefix}.resolved-cursor.v2`, this.resolved)
    if (BigInt(this.baseline(chatId)) >= BigInt(this.latestSequence(chatId)))
      this.deferredGaps.delete(chatId)
  }

  pageCursor(chatId: string, direction: 'older' | 'newer'): string | undefined {
    return this.visibility.bounds(chatId)[direction]
  }

  availability(
    chatId: string,
    readingHistory = true,
  ): { hasOlderMessages?: boolean; hasNewerMessages?: boolean } {
    const bounds = this.visibility.bounds(chatId)
    return {
      hasOlderMessages: bounds.hasOlder,
      hasNewerMessages:
        (readingHistory || this.isDetached(chatId)) &&
        bounds.newer !== undefined &&
        BigInt(this.latestSequence(chatId)) > BigInt(bounds.newer)
          ? true
          : bounds.hasNewer,
    }
  }

  verifiedSnapshot(chatId: string): { mutationSeq: string; memberSeq: string } | undefined {
    return this.visibility.verified(chatId)
  }

  snapshotMetadata(chatId: string): Partial<SnapshotMetadata> {
    return { ...this.visibility.snapshot(chatId) }
  }

  verifySnapshot(chatId: string, snapshot: { mutationSeq: string; memberSeq: string }): void {
    this.visibility.verify(chatId, snapshot)
  }

  mutationSeq(chatId: string): string {
    return this.visibility.snapshot(chatId).mutationSeq ?? '0'
  }

  revisionKey(chatId: string): string {
    return `${this.mutationSeq(chatId)}:${this.visibility.snapshot(chatId).memberSeq ?? '0'}`
  }

  snapshotSequence(chatId: string): string {
    return this.visibility.snapshot(chatId).snapshotSequence ?? '0'
  }

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

  installAround(
    chatId: string,
    incoming: Message[],
    page?: HistorySnapshot & { hasOlder?: boolean; hasNewer?: boolean },
  ): void {
    if (page) this.reconcileSnapshot(chatId, page)
    const known = mergeMessages(this.window(chatId), this.pinned[chatId] ?? [])
    this.windows = {
      ...this.windows,
      [chatId]: replaceWindow(
        mergeMessages(
          incoming,
          known.filter((message) => incoming.some((item) => item.id === message.id)),
        ),
        Boolean(page && hasCoverage(page)),
      ),
    }
    this.detachedWindows.add(chatId)
    this.visibility.setBounds(chatId, {
      older: incoming[0]?.sequence ?? page?.coverageAfterSequence,
      newer: incoming.at(-1)?.sequence ?? page?.coverageThroughSequence,
      hasOlder: page?.hasOlder,
      hasNewer: page?.hasNewer,
    })
  }

  patch(chatId: string, incoming: Message[]): void {
    this.observeSnapshot(chatId, {})
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

  settleLatest(chatId: string): void {
    this.detachedWindows.delete(chatId)
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
    this.visibility.select(selectedId)
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
    this.observeSnapshot(chatId, {})
    incoming = mergeMessages(this.historyBuffered[chatId] ?? [], incoming)
    const incomingIds = new Set(incoming.map((message) => message.id))
    incoming = mergeMessages(
      mergeMessages(this.window(chatId), this.pinned[chatId] ?? []),
      incoming,
    ).filter((message) => incomingIds.has(message.id) && this.eligible(message))
    if (!incoming.length) return false
    if (selected) {
      this.selectedChatId = chatId
      this.visibility.select(chatId)
    }
    const browsingOlder = selected && (this.isDetached(chatId) || readingHistory)
    let visible = this.window(chatId)
    const previousFirst = visible[0]?.sequence
    const incorporated: Message[] = []
    for (const message of incoming) {
      const next = selected
        ? appendLiveWindow(visible, message, browsingOlder, this.baseline(chatId))
        : !visible.length || BigInt(message.sequence) >= BigInt(visible.at(-1)!.sequence)
          ? mergeMessages(visible, [message]).slice(-1)
          : visible
      if (next !== visible) incorporated.push(message)
      visible = next
    }
    let pinned = this.pinned[chatId] ?? (selected ? this.window(chatId).slice(-50) : [])
    for (const message of incoming)
      pinned = appendLiveWindow(pinned, message, false, this.baseline(chatId)).slice(-50)
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
    const buffered = incoming.filter(
      (message) => BigInt(message.sequence) > BigInt(this.baseline(chatId)),
    )
    if (buffered.length) this.historyBuffered[chatId] = buffered.slice(0, MAX_CATCH_UP_MESSAGES)
    else delete this.historyBuffered[chatId]
    if (!browsingOlder) {
      const bounds = this.visibility.bounds(chatId)
      if (bounds)
        this.visibility.setBounds(chatId, {
          ...bounds,
          newer: visible.at(-1)?.sequence,
          hasNewer: false,
          ...(previousFirst && visible[0] && BigInt(visible[0].sequence) > BigInt(previousFirst)
            ? { older: visible[0].sequence, hasOlder: true }
            : {}),
        })
    }
    return latestChanged
  }

  latestPage(
    chatId: string,
    incoming: Message[],
    moveViewport: boolean,
    initialize: boolean,
    room: string,
    selected = true,
    snapshot?: HistorySnapshot,
  ): {
    latest?: string
    messages: Message[]
    replaced: boolean
    latestChanged: boolean
    dismissal: RecoveryFrame | null
  } {
    if (snapshot) this.reconcileSnapshot(chatId, snapshot)
    const retained = mergeMessages(this.window(chatId), this.pinned[chatId] ?? [])
    const visible = replaceWindow(
      mergeMessages(
        incoming,
        retained.filter((message) => incoming.some((item) => item.id === message.id)),
      ),
      Boolean(snapshot && hasCoverage(snapshot)),
    )
    const previousPin = this.pinned[chatId] ?? []
    const mergedPin = mergeMessages(visible, previousPin)
    if (selected)
      this.pinned[chatId] =
        (snapshot && hasCoverage(snapshot)) || isContiguous(mergedPin)
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
      const boundary = snapshot?.coverageAfterSequence ?? historyBoundaryBefore(shown)
      if (BigInt(boundary) > 0n) dismissal = this.dismiss(chatId, boundary, room)
    }
    if (replaced || initialize) this.apply(chatId, shown)
    if (snapshot) {
      if (
        initialize &&
        !shown.length &&
        snapshot.coverageAfterSequence &&
        !this.hasBaseline(chatId)
      )
        dismissal = this.dismiss(chatId, snapshot.coverageAfterSequence, room)
      this.certify(chatId, snapshot)
      if (replaced || this.visibility.bounds(chatId).older === undefined)
        this.visibility.setBounds(chatId, {
          older: snapshot.nextSequence ?? shown[0]?.sequence,
          newer: snapshot.coverageThroughSequence ?? shown.at(-1)?.sequence,
          hasOlder: snapshot.hasMore,
          hasNewer: false,
        })
    }
    if (latest && BigInt(latest) > BigInt(this.baseline(chatId))) this.deferGap(chatId)
    return { latest: shown.at(-1)?.sequence, messages: shown, replaced, latestChanged, dismissal }
  }

  page(
    chatId: string,
    incoming: Message[],
    direction: 'older' | 'newer',
    hasMore = false,
    snapshot?: HistorySnapshot,
  ): boolean {
    if (snapshot) this.reconcileSnapshot(chatId, snapshot)
    const current = this.window(chatId)
    const visible = pageWindow(
      current,
      incoming,
      direction,
      Boolean(snapshot && hasCoverage(snapshot)),
    )
    if (direction === 'older' && visible.at(-1)?.sequence !== current.at(-1)?.sequence)
      this.detachedWindows.add(chatId)
    this.windows = { ...this.windows, [chatId]: visible }
    this.apply(chatId, visible)
    if (snapshot) {
      this.certify(chatId, snapshot)
      const bounds = this.visibility.bounds(chatId)
      this.visibility.setBounds(
        chatId,
        direction === 'older'
          ? {
              ...bounds,
              older: snapshot.nextSequence ?? visible[0]?.sequence,
              hasOlder: snapshot.hasMore,
              ...(visible.at(-1)?.id !== current.at(-1)?.id
                ? { newer: visible.at(-1)?.sequence, hasNewer: true }
                : {}),
            }
          : {
              ...bounds,
              newer: snapshot.nextSequence ?? visible.at(-1)?.sequence,
              hasNewer: snapshot.hasMore,
              ...(visible[0]?.id !== current[0]?.id
                ? { older: visible[0]?.sequence, hasOlder: true }
                : {}),
            },
      )
    }
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
    this.visibility.forget(chatId)
    this.batch.persist(`${this.prefix}.resolved-cursor.v2`, resolved)
    this.batch.persist(`${this.prefix}.dismissed-through.v2`, dismissed)
    this.batch.persist(`${this.prefix}.room-cursor.v2`, rooms)
  }

  incorporateHistory(
    chatId: string,
    incoming: Message[],
    selected: boolean,
    snapshot?: HistorySnapshot,
  ): void {
    if (snapshot && hasCoverage(snapshot)) {
      this.reconcileSnapshot(chatId, snapshot)
      this.windows = {
        ...this.windows,
        [chatId]: selected
          ? pageWindow(this.window(chatId), incoming, 'newer', true)
          : mergeMessages(this.window(chatId), incoming).slice(-1),
      }
      this.certify(chatId, snapshot)
      if (selected && incoming.length)
        this.pinned[chatId] = mergeMessages(this.pinned[chatId] ?? [], incoming).slice(-50)
      this.visibility.setBounds(chatId, {
        ...this.visibility.bounds(chatId),
        newer: snapshot.nextSequence,
        hasNewer: snapshot.hasMore,
      })
      return
    }
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
