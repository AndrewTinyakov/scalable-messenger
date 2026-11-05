import { describe, expect, it } from 'vitest'
import { formatChatTime, formatDayLabel } from './time'

const now = new Date(2026, 10, 4, 12, 0)

describe('message date labels', () => {
  it('names recent days and keeps the year only for other years', () => {
    expect(formatDayLabel(new Date(2026, 10, 4, 0, 5).toISOString(), now)).toBe('Today')
    expect(formatDayLabel(new Date(2026, 10, 3, 23, 55).toISOString(), now)).toBe('Yesterday')
    expect(formatDayLabel(new Date(2026, 9, 20).toISOString(), now)).not.toMatch(/2026/)
    expect(formatDayLabel(new Date(2025, 9, 20).toISOString(), now)).toMatch(/2025/)
  })

  it('shows a clock today, a weekday this week and a date afterwards', () => {
    expect(formatChatTime(new Date(2026, 10, 4, 9, 30).toISOString(), now)).toMatch(/9:30/)
    expect(formatChatTime(new Date(2026, 10, 1).toISOString(), now)).toMatch(/^[A-Za-z]{3}$/)
    expect(formatChatTime(new Date(2026, 9, 1).toISOString(), now)).toMatch(/1/)
    expect(formatChatTime(undefined, now)).toBe('')
  })
})
