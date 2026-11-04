import { describe, expect, it } from 'vitest'
import {
  advanceAppliedSequence,
  appendLiveWindow,
  hasMoreNewer,
  hasNewAppliedMessages,
  hasUnresolvedGap,
  historyBoundaryBefore,
  MAX_VISIBLE_MESSAGES,
  pageWindow,
  replaceWindow,
} from './historyWindow'
import type { Message } from './model'

function message(sequence: number): Message {
  return {
    id: `message-${sequence}`,
    chatId: 'chat',
    sequence: String(sequence),
    senderId: 'user',
    body: String(sequence),
    createdAt: '2026-09-26T10:00:00Z',
  }
}

function range(first: number, last: number): Message[] {
  return Array.from({ length: last - first + 1 }, (_, index) => message(first + index))
}

describe('history window', () => {
  it('loads older and newer pages without retaining more than four pages', () => {
    let window = replaceWindow(range(301, 350))
    for (const first of [251, 201, 151, 101, 51])
      window = pageWindow(window, range(first, first + 49), 'older')
    expect(window).toHaveLength(MAX_VISIBLE_MESSAGES)
    expect([window[0].sequence, window.at(-1)?.sequence]).toEqual(['51', '250'])
    window = pageWindow(window, range(251, 300), 'newer')
    expect([window[0].sequence, window.at(-1)?.sequence]).toEqual(['101', '300'])
    expect(hasMoreNewer(window, '350')).toBe(true)
  })

  it('does not advance applied past an unseen gap when jumping to the newest page', () => {
    const latest = replaceWindow(range(999951, 1000000))
    expect(advanceAppliedSequence('500', latest)).toBe('500')
    expect(advanceAppliedSequence('500', range(501, 550))).toBe('550')
    const dismissedThrough = historyBoundaryBefore(latest)
    expect(dismissedThrough).toBe('999950')
    expect(hasUnresolvedGap(latest, '500')).toBe(true)
    expect(hasUnresolvedGap(latest, '1000000')).toBe(false)
    expect(advanceAppliedSequence(dismissedThrough, latest)).toBe('1000000')
    expect(hasNewAppliedMessages('500', '1000000', dismissedThrough)).toBe(true)
    expect(hasNewAppliedMessages('500', dismissedThrough, dismissedThrough)).toBe(false)
  })

  it('does not splice a live event across a missing interval', () => {
    const window = range(100, 149)
    expect(appendLiveWindow(window, message(151), false)).toBe(window)
    expect(appendLiveWindow(window, message(150), true)).toBe(window)
    expect(appendLiveWindow(window, message(150), false).at(-1)?.sequence).toBe('150')
    expect(() => pageWindow(window, range(152, 200), 'newer')).toThrow('sequence gap')
  })
})
