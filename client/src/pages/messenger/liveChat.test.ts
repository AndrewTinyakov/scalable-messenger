import { describe, expect, it } from 'vitest'
import { liveChatId } from './liveChat'

const reading = {
  selectedId: 'b',
  viewport: { chatId: 'b', atLatest: true },
  hasNewer: false,
  loadedMessages: 20,
  pageActive: true,
}

describe('live chat', () => {
  it('is the selected chat while its loaded latest messages are in view on an active page', () => {
    expect(liveChatId(reading)).toBe('b')
  })

  it('does not inherit the position reported by the previously open chat', () => {
    expect(liveChatId({ ...reading, viewport: { chatId: 'a', atLatest: true } })).toBeNull()
  })

  it('stays unknown until the selected chat reports a position', () => {
    expect(liveChatId({ ...reading, viewport: null })).toBeNull()
  })

  it('leaves unread visible when the reader is away from the latest messages', () => {
    expect(liveChatId({ ...reading, viewport: { chatId: 'b', atLatest: false } })).toBeNull()
    expect(liveChatId({ ...reading, hasNewer: true })).toBeNull()
  })

  it('leaves unread visible when nothing is loaded or the page is not active', () => {
    expect(liveChatId({ ...reading, loadedMessages: 0 })).toBeNull()
    expect(liveChatId({ ...reading, pageActive: false })).toBeNull()
  })

  it('has no live chat without a selection', () => {
    expect(liveChatId({ ...reading, selectedId: undefined, viewport: null })).toBeNull()
  })
})
