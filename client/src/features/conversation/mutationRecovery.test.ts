import { describe, expect, it, vi } from 'vitest'
import { message } from '../../entities/message/chatRecovery.fixtures'
import { MutationRecovery } from './mutationRecovery'

describe('durable mutation recovery', () => {
  it('recovers an edit and later delete by mutation revision even when their message sequence is old', async () => {
    const patch = vi.fn()
    const changes = vi
      .fn()
      .mockResolvedValueOnce({
        changes: [
          { revision: '8', message: { ...message('1'), body: 'edited', messageVersion: '2' } },
        ],
        lastRevision: '9',
        nextRevision: '8',
        resetRequired: false,
      })
      .mockResolvedValueOnce({
        changes: [
          {
            revision: '9',
            message: {
              ...message('1'),
              body: '',
              deletedAt: '2026-11-04T10:00:00Z',
              messageVersion: '3',
            },
          },
        ],
        lastRevision: '9',
        nextRevision: '9',
        resetRequired: false,
      })
    const recovery = new MutationRecovery({ changes, patch, reset: vi.fn() })
    recovery.select('chat')
    recovery.snapshot('chat', '7')
    await Promise.all([recovery.refresh(), recovery.refresh()])
    expect(changes.mock.calls).toEqual([
      ['chat', '7'],
      ['chat', '8'],
    ])
    expect(patch.mock.calls[1][1][0]).toMatchObject({
      sequence: '1',
      messageVersion: '3',
      body: '',
    })
  })

  it('refreshes retained snapshots when the cursor expires and resumes at the captured revision', async () => {
    const changes = vi
      .fn()
      .mockResolvedValueOnce({
        changes: [],
        lastRevision: '200',
        nextRevision: '1',
        resetRequired: true,
      })
      .mockResolvedValueOnce({
        changes: [],
        lastRevision: '200',
        nextRevision: '200',
        resetRequired: false,
      })
    const reset = vi.fn().mockResolvedValue('200')
    const recovery = new MutationRecovery({ changes, reset, patch: vi.fn() })
    recovery.select('chat')
    recovery.snapshot('chat', '1')
    await recovery.refresh()
    await recovery.refresh()
    expect(reset).toHaveBeenCalledExactlyOnceWith('chat')
    expect(changes.mock.calls).toEqual([
      ['chat', '1'],
      ['chat', '200'],
    ])
  })

  it('discards a completion after chat removal or selection change', async () => {
    let finish!: (value: {
      changes: { revision: string; message: ReturnType<typeof message> }[]
      lastRevision: string
      nextRevision: string
      resetRequired: boolean
    }) => void
    const patch = vi.fn()
    const recovery = new MutationRecovery({
      changes: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
      reset: vi.fn(),
      patch,
    })
    recovery.select('old')
    recovery.snapshot('old', '1')
    const running = recovery.refresh()
    recovery.select('new')
    finish({
      changes: [{ revision: '2', message: message('1') }],
      lastRevision: '2',
      nextRevision: '2',
      resetRequired: false,
    })
    await running
    expect(patch).not.toHaveBeenCalled()
  })

  it('caps catch-up at ten pages and replaces retained snapshots', async () => {
    let revision = 0
    const changes = vi.fn(async () => ({
      changes: [],
      lastRevision: '99999',
      nextRevision: String(++revision),
      resetRequired: false,
    }))
    const reset = vi.fn().mockResolvedValue('99999')
    const recovery = new MutationRecovery({ changes, reset, patch: vi.fn() })
    recovery.select('chat')
    recovery.snapshot('chat', '0')
    await recovery.refresh()
    expect(changes).toHaveBeenCalledTimes(10)
    expect(reset).toHaveBeenCalledExactlyOnceWith('chat')
  })
})
