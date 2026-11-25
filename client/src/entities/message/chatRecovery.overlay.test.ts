import { describe, expect, it, vi } from 'vitest'
import { connectedRecovery, message } from './chatRecovery.fixtures'
import type { Message } from './model'

function snapshot(messages: Message[], revision = '0') {
  return {
    messages,
    snapshotSequence: '2',
    mutationSeq: revision,
    visibilitySeq: revision,
    clearedThroughSequence: '0',
    globalClearedThroughSequence: '0',
    coverageAfterSequence: '0',
    coverageThroughSequence: '2',
    nextSequence: '2',
    hasMore: false,
  }
}

describe('pending viewer-authorized history overlays', () => {
  it.each([false, true])(
    'keeps canonical quote absence after a revision advance with target overlay=%s',
    async (overlayTarget) => {
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
      let revision = '0'
      const { recovery } = connectedRecovery({
        latest: async () => snapshot(revision === '0' ? [target, reply] : [unavailable], revision),
        after: async () => snapshot([], revision),
        older: async () => snapshot([], revision),
        visibility: async () => ({ ...snapshot([], revision), hidden: false }),
        resolve: async (_chat, ids) =>
          snapshot(
            (revision === '0' ? [target, edited] : [unavailable]).filter((row) =>
              ids.includes(row.id),
            ),
            revision,
          ),
      })
      try {
        await recovery.catchUp('chat', true)
        let release!: (value: ReturnType<typeof snapshot>) => void
        const loading = recovery.withHistorySnapshot(
          'chat',
          () =>
            new Promise<ReturnType<typeof snapshot>>((resolve) => {
              release = resolve
            }),
          (page) => recovery.reveal('chat', page.messages, recovery.beginNavigation(), page),
        )
        recovery.patch('chat', [edited])
        await vi.waitFor(() =>
          expect(
            recovery.visibleWindows().chat.find((row) => row.id === reply.id)?.messageVersion,
          ).toBe('2'),
        )
        if (overlayTarget)
          recovery.patch('chat', [
            { ...target, body: 'erased target overlay secret', messageVersion: '3' },
          ])
        revision = '1'
        await recovery.synchronize('chat', { mutationSeq: '1', visibilitySeq: '1' })
        expect(recovery.visibleWindows().chat[0].replyBody).toBeNull()
        release(snapshot([unavailable], revision))
        expect(await loading).toBe(true)
        expect(recovery.visibleWindows().chat[0]).toMatchObject({
          body: 'edited reply',
          messageVersion: '2',
          replyBody: null,
          replyVersion: null,
        })
        expect(JSON.stringify(recovery.visibleWindows())).not.toContain('secret')
        expect(JSON.stringify(recovery.latestWindows())).not.toContain('secret')
      } finally {
        recovery.dispose()
      }
    },
  )
})
