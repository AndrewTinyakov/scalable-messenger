import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { connectedRecovery, message } from '../../entities/message/chatRecovery.fixtures'
import type { ChangesSnapshot } from '../../entities/message/historySnapshot'
import type { Message } from '../../entities/message/model'
import type { api } from '../../shared/api/http'
import { useConversationFeatures } from './useConversationFeatures'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function fixture() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const target = { ...message('1'), body: 'erased quote secret' }
  const reply = {
    ...message('2'),
    replyToMessageId: target.id,
    replySenderId: target.senderId,
    replyBody: target.body,
    replyVersion: '1',
    replyDeleted: false,
  }
  const edited = { ...reply, body: 'edited reply', messageVersion: '2' }
  const unavailable = {
    ...edited,
    replySenderId: null,
    replyBody: null,
    replyVersion: null,
    replyDeleted: null,
  }
  let hidden = false
  const metadata = () => ({
    snapshotSequence: '2',
    mutationRevision: hidden ? '1' : '0',
    visibilityRevision: hidden ? '1' : '0',
    clearedThroughSequence: '0',
    globalClearedThroughSequence: '0',
  })
  const snapshot = () => ({
    ...metadata(),
    messages: hidden ? [unavailable] : [target, reply],
    coverageAfterSequence: '0',
    coverageThroughSequence: '2',
    nextSequence: '2',
    hasMore: false,
  })
  const resolve = vi.fn(async (_chat: string, ids: string[]) => ({
    ...metadata(),
    messages: (hidden ? [unavailable] : [target, reply]).filter((row) => ids.includes(row.id)),
  }))
  const { recovery } = connectedRecovery({
    latest: async () => snapshot(),
    after: async () => snapshot(),
    older: async () => snapshot(),
    visibility: async () => ({ ...metadata(), hidden: false }),
    resolve,
  })
  await recovery.catchUp('chat', true)
  const oldChanges: ChangesSnapshot = {
    snapshotSequence: '2',
    visibilityRevision: '0',
    clearedThroughSequence: '0',
    globalClearedThroughSequence: '0',
    changes: [
      {
        revision: '1',
        kind: 'UPSERT' as const,
        message: edited,
        messageId: edited.id,
        sequence: '2',
        clearedThroughSequence: null,
      },
    ],
    lastRevision: '1',
    nextRevision: '1',
    resetRequired: false,
  }
  const changing = deferred<typeof oldChanges>()
  const editing = deferred<Message>()
  const service = {
    messageChanges: vi.fn(async (_id: string, _after: string) => changing.promise),
    editMessage: vi.fn(async () => editing.promise),
    reads: vi.fn(async () => ({
      throughSequence: '0',
      maxOtherReadSequence: '0',
      serverTime: new Date().toISOString(),
    })),
  }
  let features!: ReturnType<typeof useConversationFeatures>
  function Harness() {
    features = useConversationFeatures({
      chat: { id: 'chat', kind: 'DIRECT', members: [], memberCount: 2, lastSequence: '2' },
      connected: true,
      recovery,
      sessionApi: service as unknown as ReturnType<typeof api.forSession>,
      send: () => {},
      remove: () => {},
      fail: () => {},
    })
    return null
  }
  await act(async () => root.render(<Harness />))
  return {
    recovery,
    target,
    reply,
    edited,
    unavailable,
    changing,
    editing,
    oldChanges,
    service,
    resolve,
    get: () => features,
    hide: async () => {
      hidden = true
      await act(async () =>
        recovery.synchronize('chat', { mutationRevision: '1', visibilityRevision: '1' }),
      )
    },
    close: async () => {
      await act(async () => root.unmount())
      recovery.dispose()
      dom.window.close()
      vi.unstubAllGlobals()
    },
  }
}

describe('viewer snapshots racing with conversation callers', () => {
  it('rejects an in-flight old changes page and retries its cursor after personal deletion', async () => {
    const f = await fixture()
    try {
      await act(async () => f.get().snapshot('chat', '0'))
      expect(f.service.messageChanges).toHaveBeenCalledExactlyOnceWith('chat', '0')
      await f.hide()
      f.service.messageChanges.mockImplementation(async () => ({
        ...f.oldChanges,
        visibilityRevision: '1',
        changes: [{ ...f.oldChanges.changes[0], message: f.unavailable }],
      }))
      await act(async () => f.changing.resolve(f.oldChanges))
      expect(f.recovery.visibleWindows().chat.map((row) => row.id)).toEqual(['message-2'])
      expect(f.recovery.visibleWindows().chat[0].replyBody).toBeNull()
      expect(f.service.messageChanges.mock.calls).toEqual([
        ['chat', '0'],
        ['chat', '0'],
      ])
    } finally {
      await f.close()
    }
  })

  it('revalidates a late edit response quote even when its message is below the applied baseline', async () => {
    const f = await fixture()
    try {
      let edited!: Promise<void>
      await act(async () => {
        edited = f.get().editMessage(f.reply, 'edited reply')
      })
      await f.hide()
      expect(f.recovery.baseline('chat')).toBe('2')
      await act(async () => {
        f.editing.resolve(f.edited)
        await edited
      })
      expect(f.recovery.visibleWindows().chat[0].replyBody).toBeNull()
      expect(JSON.stringify(f.recovery.visibleWindows())).not.toContain('erased quote secret')
      expect(f.resolve).toHaveBeenCalledWith('chat', ['message-2'])
    } finally {
      await f.close()
    }
  })
})
