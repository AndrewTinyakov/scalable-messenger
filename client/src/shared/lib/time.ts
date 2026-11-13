const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const longDate = new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric' })
const fullDate = new Intl.DateTimeFormat(undefined, {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
})

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function daysAgo(date: Date, now: Date): number {
  return Math.round((startOfDay(now) - startOfDay(date)) / 86400000)
}

export function formatMessageTime(timestamp: string): string {
  return clock.format(new Date(timestamp))
}

export function formatChatTime(timestamp?: string, now = new Date()): string {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  const age = daysAgo(date, now)
  if (age <= 0) return clock.format(date)
  if (age < 7) return weekday.format(date)
  return shortDate.format(date)
}

export function formatReadTime(timestamp: string, now = new Date()): string {
  const date = new Date(timestamp)
  const age = daysAgo(date, now)
  const day = age <= 0 ? 'today' : age === 1 ? 'yesterday' : shortDate.format(date)
  return `${day} at ${clock.format(date)}`
}

export function formatDayLabel(timestamp: string, now = new Date()): string {
  const date = new Date(timestamp)
  const age = daysAgo(date, now)
  if (age <= 0) return 'Today'
  if (age === 1) return 'Yesterday'
  return date.getFullYear() === now.getFullYear() ? longDate.format(date) : fullDate.format(date)
}
