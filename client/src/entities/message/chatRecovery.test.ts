import { describe, expect, it } from 'vitest'
import { ChatRecovery } from './chatRecovery'
import type { Message } from './model'

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
  }
}

function message(sequence: string): Message {
  return { id: `message-${sequence}`, chatId: 'chat', sequence, senderId: 'sender', body: sequence, createdAt: '2026-01-01T00:00:00Z' }
}

describe('ChatRecovery', () => {
  it('keeps an in-memory baseline when storage is blocked', () => {
    const blocked: Pick<Storage, 'getItem' | 'setItem'> = {
      getItem: () => { throw new Error('storage blocked') },
      setItem: () => { throw new Error('storage blocked') },
    }
    const recovery = new ChatRecovery('device', blocked)
    recovery.apply('chat', [message('1')])
    expect(recovery.baseline('chat')).toBe('1')
    expect(recovery.acknowledgeLive('chat', '1', 'group:chat')).toEqual({ type: 'applied', version: 1, chatId: 'chat', sequence: '1' })
  })

  it('persists an explicit dismissal separately from subsequent applied messages', () => {
    const storage = memoryStorage()
    const recovery = new ChatRecovery('device', storage)

    expect(recovery.dismiss('chat', '8', 'group:chat')).toEqual({ type: 'dismissed', version: 1, chatId: 'chat', sequence: '8' })
    recovery.apply('chat', [message('9'), message('10')])
    expect(recovery.appliedSince('chat', '0')).toEqual({ type: 'applied', version: 1, chatId: 'chat', sequence: '10' })
    expect(recovery.acknowledgeLive('chat', '8', 'group:chat')).toBeNull()

    const restored = new ChatRecovery('device', storage)
    expect(restored.subscription('chat', 'group:chat')).toEqual({ lastAppliedSequence: '10' })
    expect(restored.dismissalFrame('chat')).toEqual({ type: 'dismissed', version: 1, chatId: 'chat', sequence: '8' })
  })

  it('waits for a gap before acknowledging a live message or storing its room cursor', () => {
    const storage = memoryStorage()
    const recovery = new ChatRecovery('device', storage)
    recovery.apply('chat', [message('1')])

    expect(recovery.liveMessage('chat', '3')).toEqual({ incorporate: true, catchUp: true })
    expect(recovery.acknowledgeLive('chat', '3', 'group:chat', 'epoch', '30-0')).toBeNull()
    expect(recovery.subscription('chat', 'group:chat')).toEqual({ lastAppliedSequence: '1' })

    recovery.apply('chat', [message('2'), message('3')])
    expect(recovery.acknowledgeLive('chat', '3', 'group:chat', 'epoch', '30-0')).toEqual({
      type: 'applied', version: 1, chatId: 'chat', sequence: '3', epoch: 'epoch', streamId: '30-0',
    })
    expect(recovery.subscription('chat', 'group:chat')).toEqual({ lastAppliedSequence: '3', epoch: 'epoch', streamId: '30-0' })
  })

  it('clears room replay position when a gap is dismissed', () => {
    const recovery = new ChatRecovery('device', memoryStorage())
    recovery.apply('chat', [message('1')])
    recovery.acknowledgeLive('chat', '1', 'group:chat', 'epoch', '1-0')
    recovery.deferGap('chat')
    expect(recovery.liveMessage('chat', '5').catchUp).toBe(false)

    recovery.dismiss('chat', '4', 'group:chat')
    expect(recovery.subscription('chat', 'group:chat')).toEqual({ lastAppliedSequence: '4' })
    expect(recovery.liveMessage('chat', '5').catchUp).toBe(false)
    expect(recovery.appliedSince('chat', '1')).toBeNull()
  })

  it('keeps an older detached window while live messages arrive, then pages forward', () => {
    const recovery = new ChatRecovery('device', memoryStorage())
    recovery.latestPage('chat', Array.from({ length: 200 }, (_, index) => message(String(index + 51))), true, false, 'group:chat')
    recovery.page('chat', Array.from({ length: 50 }, (_, index) => message(String(index + 1))), 'older')
    expect(recovery.isDetached('chat')).toBe(true)
    expect(recovery.window('chat')[0].sequence).toBe('1')
    expect(recovery.window('chat').at(-1)?.sequence).toBe('200')

    recovery.receive('chat', [message('251')], true, false)
    expect(recovery.window('chat').at(-1)?.sequence).toBe('200')
    expect(recovery.latestSequence('chat')).toBe('251')
    expect(recovery.baseline('chat')).toBe('200')

    recovery.page('chat', Array.from({ length: 51 }, (_, index) => message(String(index + 201))), 'newer')
    expect(recovery.window('chat').at(-1)?.sequence).toBe('251')
    expect(recovery.baseline('chat')).toBe('251')
    expect(recovery.isDetached('chat')).toBe(false)
  })

  it('does not replace a newer live window with a stale latest page', () => {
    const recovery = new ChatRecovery('device', memoryStorage())
    recovery.latestPage('chat', [message('1'), message('2')], true, true, 'group:chat')
    recovery.receive('chat', [message('3')], true, false)

    const page = recovery.latestPage('chat', [message('1'), message('2')], true, false, 'group:chat')
    expect(page.replaced).toBe(false)
    expect(page.latest).toBe('3')
    expect(recovery.window('chat').map((item) => item.sequence)).toEqual(['1', '2', '3'])
    expect(recovery.baseline('chat')).toBe('3')
  })

  it('dismisses only the unseen prefix when opening a latest page on a new device', () => {
    const recovery = new ChatRecovery('device', memoryStorage())
    const page = recovery.latestPage('chat', [message('8'), message('9')], true, true, 'group:chat')
    expect(page.dismissal).toEqual({ type: 'dismissed', version: 1, chatId: 'chat', sequence: '7' })
    expect(recovery.baseline('chat')).toBe('9')
    expect(recovery.dismissalFrame('chat')).toEqual(page.dismissal)
  })
})
