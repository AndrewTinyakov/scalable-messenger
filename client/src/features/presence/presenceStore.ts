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
  members: 100,
  header: 10,
  profile: 10,
}
const PINNED = new Set<PresenceSource>(['header', 'profile'])
/** Sources that fill the remaining capacity, most important first. */
const FILL_ORDER: PresenceSource[] = ['members', 'sidebar']

export const MAX_WATCHED = 500
export const UNWATCH_DELAY_MS = 10_000
const MIN_SEND_GAP_MS = 1000

/** A status the UI can render. `unavailable` means the viewer may not see it. */
export type PresenceView = PresenceStatus | { userId: string; unavailable: true }

export type PresenceSnapshot = {
  statuses: ReadonlyMap<string, PresenceView>
  onlineCounts: ReadonlyMap<string, { online: number; members: number }>
}

/**
 * Collects which users every part of the UI needs, sends one watch per
 * connection and keeps the latest status per user.
 */
export class PresenceStore {
  private sources = new Map<PresenceSource, string[]>()
  private sent = new Set<string>()
  private removals = new Map<string, number>()
  private statuses = new Map<string, PresenceView>()
  private onlineCounts = new Map<string, { online: number; members: number }>()
  private countChat: string | undefined
  private listeners = new Set<() => void>()
  private snapshot: PresenceSnapshot = { statuses: this.statuses, onlineCounts: this.onlineCounts }
  private send: ((frame: OutgoingSocketFrame) => void) | null = null
  private released = false
  private timer?: ReturnType<typeof setTimeout>
  private lastSentAt = 0
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

  /** Replaces the users one source needs, in priority order. */
  watch(source: PresenceSource, ids: readonly string[]) {
    const next = [...new Set(ids)].slice(0, BUDGETS[source])
    const previous = this.sources.get(source) ?? []
    if (next.length === previous.length && next.every((id, index) => id === previous[index])) return
    if (next.length) this.sources.set(source, next)
    else this.sources.delete(source)
    this.schedule()
  }

  watchOnlineCount(chatId: string | undefined) {
    if (chatId === this.countChat) return
    this.countChat = chatId
    this.send?.({ type: 'watch_online_count', version: 1, ...(chatId ? { chatId } : {}) })
  }

  /** Starts a fresh watch on a new connection, or stops sending when null. */
  connect(send: ((frame: OutgoingSocketFrame) => void) | null) {
    this.send = send
    this.sent.clear()
    this.removals.clear()
    clearTimeout(this.timer)
    this.timer = undefined
    if (!send) return
    const add = this.released ? [] : [...this.desired()]
    send({ type: 'watch_presence', version: 1, reset: true, add })
    add.forEach((id) => this.sent.add(id))
    this.lastSentAt = this.now()
    if (this.countChat) send({ type: 'watch_online_count', version: 1, chatId: this.countChat })
  }

  /** Drops all watches while the page stays hidden, and restores them later. */
  setReleased(released: boolean) {
    if (released === this.released) return
    this.released = released
    if (this.send) this.connect(this.send)
  }

  onEvent(event: SocketEvent): boolean {
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

  private publish() {
    this.snapshot = { statuses: this.statuses, onlineCounts: this.onlineCounts }
    this.listeners.forEach((listener) => listener())
  }

  private desired(): Set<string> {
    const ids = new Set<string>()
    for (const [source, list] of this.sources)
      if (PINNED.has(source)) list.forEach((id) => ids.add(id))
    for (const source of FILL_ORDER)
      for (const id of this.sources.get(source) ?? []) {
        if (ids.size >= MAX_WATCHED) break
        ids.add(id)
      }
    return ids
  }

  private schedule() {
    if (!this.send || this.timer) return
    const delay = Math.max(0, this.lastSentAt + MIN_SEND_GAP_MS - this.now())
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, delay)
  }

  private flush() {
    if (!this.send || this.released) return
    const now = this.now()
    const desired = this.desired()
    const add = [...desired].filter((id) => !this.sent.has(id))
    for (const id of desired) this.removals.delete(id)
    const overCap = this.sent.size + add.length > MAX_WATCHED
    const remove: string[] = []
    for (const id of this.sent) {
      if (desired.has(id)) continue
      const since = this.removals.get(id) ?? now
      this.removals.set(id, since)
      if (overCap || now - since >= UNWATCH_DELAY_MS) remove.push(id)
    }
    remove.forEach((id) => {
      this.sent.delete(id)
      this.removals.delete(id)
    })
    add.forEach((id) => this.sent.add(id))
    if (add.length || remove.length) {
      this.send({ type: 'watch_presence', version: 1, add, remove })
      this.lastSentAt = now
    }
    if (this.removals.size) {
      const next = Math.min(...this.removals.values()) + UNWATCH_DELAY_MS
      this.timer = setTimeout(
        () => {
          this.timer = undefined
          this.flush()
        },
        Math.max(MIN_SEND_GAP_MS, next - now),
      )
    }
  }
}
