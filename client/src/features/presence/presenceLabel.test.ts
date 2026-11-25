import { expect, it } from 'vitest'
import { presenceLabel } from './presenceLabel'

const userId = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const now = Date.parse('2026-11-25T12:00:00Z')

it('labels every known status and never leaves a known user blank', () => {
  expect(presenceLabel(undefined, now)).toBe('')
  expect(presenceLabel({ userId, online: true }, now)).toBe('online')
  expect(presenceLabel({ userId, unavailable: true }, now)).toBe('last seen recently')
  expect(presenceLabel({ userId, online: false }, now)).toBe('last seen a long time ago')
  expect(presenceLabel({ userId, online: false, lastSeen: 'within_week' }, now)).toBe(
    'last seen within a week',
  )
  expect(presenceLabel({ userId, online: false, lastSeenAt: '2026-11-25T11:59:30Z' }, now)).toBe(
    'last seen just now',
  )
  expect(presenceLabel({ userId, online: false, lastSeenAt: '2026-11-25T11:55:00Z' }, now)).toBe(
    'last seen 5 minutes ago',
  )
  expect(presenceLabel({ userId, online: false, lastSeenAt: '2026-11-25T11:59:00Z' }, now)).toBe(
    'last seen 1 minute ago',
  )
  expect(presenceLabel({ userId, online: false, lastSeenAt: '2026-11-25T08:00:00Z' }, now)).toMatch(
    /^last seen today at /,
  )
})
