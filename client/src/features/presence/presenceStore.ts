import type {
  OutgoingSocketFrame,
  PresenceConfig,
  PresenceStatus,
  SocketEvent,
} from '../../shared/api/socket'

/** Where a watch comes from. Pinned sources are never evicted by the cap. */
export type PresenceSource = 'sidebar' | 'header' | 'members' | 'profile'

const BUDGETS: Record<PresenceSource, number> = {
  sidebar: 200,
  members: 500,
  header: 10,
  profile: 10,
}
const PINNED: PresenceSource[] = ['header', 'profile']
/** Sources that fill the remaining capacity, most important first. */
const FILL_ORDER: PresenceSource[] = ['members', 'sidebar']

export const MAX_WATCHED = 500
export const UNWATCH_DELAY_MS = 10_000
/**
 * Watch frames go out in a short burst, then one per second. The gateway
 * allows each user a burst of 30 and 3 per second across all their tabs.
 */
const SEND_BURST = 4
const SEND_INTERVAL_MS = 1000
const RATE_LIMIT_RETRY_MS = 3000

/** A status the UI can render. `unavailable` means the viewer may not see it. */
export type PresenceView = PresenceStatus | { userId: string; unavailable: true }

export type PresenceSnapshot = {
  statuses: ReadonlyMap<string, PresenceView>
  onlineCounts: ReadonlyMap<string, { online: number; members: number }>
}

/**
 * Collects which users every part of the UI needs, sends one paced watch per
 * connection and keeps the latest status per user.
 */
export class PresenceStore {
  private consumers = new Map<PresenceSource, Map<object, readonly string[]>>()
  private sent = new Set<string>()
  private removals = new Map<string, number>()
  private statuses = new Map<string, PresenceView>()
  private onlineCounts = new Map<string, { online: number; members: number }>()
  private countWanted: string | undefined
  /** The count watch the gateway has; null when it must be sent again. */
  private countSent: string | undefined | null
  private listeners = new Set<() => void>()
  private snapshot: PresenceSnapshot = { statuses: this.statuses, onlineCounts: this.onlineCounts }
  private send: ((frame: OutgoingSocketFrame) => void) | null = null
  private released = false
  private resyncAt: number | undefined
  private timer?: ReturnType<typeof setTimeout>
  private timerAt = Infinity
  private sendTokens = SEND_BURST
  private refilledAt = -Infinity
  config: PresenceConfig = {
    idleAfterHiddenMs: 5000,
    idleAfterInputMs: 30000,
    releaseAfterHiddenMs: 300000,
  }

  constructor(private readonly now: () => number = Date.now) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = () => this.snapshot

  /** Replaces the users one consumer of a source needs, in priority order. */
  watch(source: PresenceSource, consumer: object, ids: readonly string[]) {
    const consumers = this.consumers.get(source) ?? new Map<object, readonly string[]>()
    if (ids.length) consumers.set(consumer, ids)
    else consumers.delete(consumer)
    this.consumers.set(source, consumers)
    this.schedule(this.now())
  }

  /** Follows one small group's online count; the key changes with its size. */
  watchOnlineCount(chatId: string | undefined, members = 0) {
    const key = chatId ? `${chatId}:${members}` : undefined
    if (key === this.countWanted) return
    this.countWanted = key
    this.schedule(this.now())
  }

  /** Starts a fresh watch on a new connection, or stops sending when null. */
  connect(send: ((frame: OutgoingSocketFrame) => void) | null) {
    this.countSent = this.countWanted === undefined ? undefined : null
    this.send = send
    this.sent.clear()
    this.removals.clear()
    this.resyncAt = undefined
    this.clearTimer()
    if (!send) return
    const add = this.released ? [] : [...this.desired()]
    send({ type: 'watch_presence', version: 1, reset: true, add })
    if (this.released) {
      send({ type: 'watch_online_count', version: 1 })
      this.countSent = undefined
    }
    add.forEach((id) => this.sent.add(id))
    this.spend(this.now())
    this.schedule(this.now())
  }

  /** Drops all watches while the page stays hidden, and restores them later. */
  setReleased(released: boolean) {
    if (released === this.released) return
    this.released = released
    if (!this.send) return
    // A pending rate-limit replay rebuilds everything for the new state.
    if (this.resyncAt !== undefined) return this.schedule(this.resyncAt)
    this.connect(this.send)
  }

  onEvent = (event: SocketEvent): boolean => {
    if (event.type === 'error' && event.code === 'RATE_LIMITED' && !event.requestId) {
      // The gateway may have refused a watch; send the whole set again later.
      this.resyncAt ??= this.now() + RATE_LIMIT_RETRY_MS
      this.schedule(this.resyncAt)
      return false
    }
    if (event.type === 'chat_created' || event.type === 'membership_changed') this.retryDenied()
    if (event.type === 'membership_changed' || event.type === 'member_removed') {
      if (this.countWanted?.startsWith(`${event.chatId}:`)) {
        this.countSent = null
        this.schedule(this.now())
      }
      return false
    }
    if (event.type === 'presence_config') {
      const { idleAfterHiddenMs, idleAfterInputMs, releaseAfterHiddenMs } = event
      this.config = { idleAfterHiddenMs, idleAfterInputMs, releaseAfterHiddenMs }
      return true
    }
    if (event.type === 'online_count') {
      this.onlineCounts = new Map(this.onlineCounts).set(event.chatId, {
        online: event.online,
        members: event.members,
      })
      this.publish()
      return true
    }
    if (event.type !== 'presence') return false
    this.statuses = new Map(this.statuses)
    for (const status of event.statuses) this.statuses.set(status.userId, status)
    for (const userId of event.unavailable ?? [])
      this.statuses.set(userId, { userId, unavailable: true })
    this.publish()
    return true
  }

  /**
   * A new chat may let this user see someone the gateway refused. The gateway
   * only rechecks grants it already holds, so ask for the refused users again.
   */
  private retryDenied() {
    const denied = [...this.sent].filter((id) => {
      const view = this.statuses.get(id)
      return view && 'unavailable' in view
    })
    denied.forEach((id) => this.sent.delete(id))
    if (denied.length) this.schedule(this.now())
  }

  private publish() {
    this.snapshot = { statuses: this.statuses, onlineCounts: this.onlineCounts }
    this.listeners.forEach((listener) => listener())
  }

  private ids(source: PresenceSource): string[] {
    const union = new Set<string>()
    for (const ids of this.consumers.get(source)?.values() ?? []) ids.forEach((id) => union.add(id))
    return [...union].slice(0, BUDGETS[source])
  }

  private desired(): Set<string> {
    const ids = new Set<string>()
    for (const source of PINNED) this.ids(source).forEach((id) => ids.add(id))
    for (const source of FILL_ORDER)
      for (const id of this.ids(source)) {
        if (ids.size >= MAX_WATCHED) break
        ids.add(id)
      }
    return ids
  }

  private clearTimer() {
    clearTimeout(this.timer)
    this.timer = undefined
    this.timerAt = Infinity
  }

  private refill(now: number) {
    const earned = (now - this.refilledAt) / SEND_INTERVAL_MS
    this.sendTokens = Math.min(SEND_BURST, this.sendTokens + earned)
    this.refilledAt = now
  }

  private spend(now: number) {
    this.refill(now)
    this.sendTokens -= 1
  }

  /** When the pacing next allows a frame. */
  private nextSendAt() {
    const now = this.now()
    this.refill(now)
    return this.sendTokens >= 1 ? now : now + (1 - this.sendTokens) * SEND_INTERVAL_MS
  }

  /** Flushes no earlier than `at` and the send pacing allow. */
  private schedule(at: number) {
    if (!this.send) return
    const due = Math.max(at, this.nextSendAt())
    if (due >= this.timerAt) return
    clearTimeout(this.timer)
    this.timerAt = due
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        this.timerAt = Infinity
        this.flush()
      },
      Math.max(0, due - this.now()),
    )
  }

  private flush() {
    const send = this.send
    if (!send) return
    const now = this.now()
    if (this.resyncAt !== undefined) {
      if (now < this.resyncAt) return this.schedule(this.resyncAt)
      this.connect(send)
      // A refused clear may have left the gateway counting an old group.
      if (this.countSent === undefined) this.countSent = null
      return this.schedule(this.now())
    }
    if (this.released) return
    const desired = this.desired()
    const add = [...desired].filter((id) => !this.sent.has(id))
    for (const id of desired) this.removals.delete(id)
    for (const id of this.sent)
      if (!desired.has(id) && !this.removals.has(id)) this.removals.set(id, now)
    const remove = [...this.removals]
      .filter(([, since]) => now - since >= UNWATCH_DELAY_MS)
      .map(([id]) => id)
    const lingering = [...this.removals].sort((a, b) => a[1] - b[1]).map(([id]) => id)
    for (const id of lingering) {
      if (this.sent.size - remove.length + add.length <= MAX_WATCHED) break
      if (!remove.includes(id)) remove.push(id)
    }
    // Count changes are rare and go first so presence churn cannot starve them.
    if (this.countWanted !== this.countSent) {
      const chatId = this.countWanted?.split(':')[0]
      send({ type: 'watch_online_count', version: 1, ...(chatId ? { chatId } : {}) })
      this.countSent = this.countWanted
      this.spend(now)
      this.schedule(now)
      return
    }
    remove.forEach((id) => {
      this.sent.delete(id)
      this.removals.delete(id)
    })
    add.forEach((id) => this.sent.add(id))
    if (add.length || remove.length) {
      send({ type: 'watch_presence', version: 1, add, remove })
      this.spend(now)
    }
    if (this.removals.size) this.schedule(Math.min(...this.removals.values()) + UNWATCH_DELAY_MS)
  }
}
