import type { PresenceView } from './presenceStore'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const BUCKETS = {
  recently: 'last seen recently',
  within_week: 'last seen within a week',
  within_month: 'last seen within a month',
  long_ago: 'last seen a long time ago',
} as const

/** Text for a user's status. Never empty once a status has arrived. */
export function presenceLabel(view: PresenceView | undefined, now = Date.now()): string {
  if (!view) return ''
  if ('unavailable' in view) return BUCKETS.recently
  if (view.online) return 'online'
  if (view.lastSeen) return BUCKETS[view.lastSeen]
  if (!view.lastSeenAt) return BUCKETS.long_ago
  const seen = new Date(view.lastSeenAt)
  const age = now - seen.getTime()
  if (age < MINUTE) return 'last seen just now'
  if (age < HOUR) {
    const minutes = Math.floor(age / MINUTE)
    return `last seen ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`
  }
  const time = seen.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const today = new Date(now)
  const yesterday = new Date(now - 24 * HOUR)
  if (seen.toDateString() === today.toDateString()) return `last seen today at ${time}`
  if (seen.toDateString() === yesterday.toDateString()) return `last seen yesterday at ${time}`
  return `last seen ${seen.toLocaleDateString([], { day: 'numeric', month: 'short', year: seen.getFullYear() === today.getFullYear() ? undefined : 'numeric' })}`
}

export function isOnline(view: PresenceView | undefined): boolean {
  return Boolean(view && !('unavailable' in view) && view.online)
}
