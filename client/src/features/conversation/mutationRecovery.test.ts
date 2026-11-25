import { describe, expect, it, vi } from 'vitest'
import { message } from '../../entities/message/chatRecovery.fixtures'
import { MutationRecovery } from './mutationRecovery'

describe('durable mutation recovery', () => {
  it('keeps its cursor after ten rejected pages and retries from that cursor later', async () => {
    const changes = vi.fn(async (_chat: string, _after: string) => ({
      changes: [{ seq: '8', message: message('1') }],
      lastSeq: '8',
      nextSeq: '8',
      resetRequired: false,
    }))
    const apply = vi.fn().mockReturnValue(false)
    const reset = vi.fn()
    const recovery = new MutationRecovery({ changes, apply, reset, patch: vi.fn() })
    recovery.select('chat')
    recovery.snapshot('chat', '7')
    await recovery.refresh()
    expect(changes).toHaveBeenCalledTimes(10)
    expect(reset).not.toHaveBeenCalled()
    apply.mockReturnValue(true)
    await recovery.refresh()
    expect(changes.mock.calls[10]).toEqual(['chat', '7'])
    expect(changes).toHaveBeenCalledTimes(11)
  })
  it('recovers an edit and later delete by mutation revision even when their message sequence is old', async () => {
    const patch = vi.fn()
    const changes = vi
      .fn()
      .mockResolvedValueOnce({
        changes: [{ seq: '8', message: { ...message('1'), body: 'edited', messageVersion: '2' } }],
        lastSeq: '9',
        nextSeq: '8',
        resetRequired: false,
      })
      .mockResolvedValueOnce({
        changes: [
          {
            seq: '9',
            message: {
              ...message('1'),
              body: '',
              deletedAt: '2026-11-04T10:00:00Z',
              messageVersion: '3',
            },
          },
        ],
        lastSeq: '9',
        nextSeq: '9',
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
        lastSeq: '200',
        nextSeq: '1',
        resetRequired: true,
      })
      .mockResolvedValueOnce({
        changes: [],
        lastSeq: '200',
        nextSeq: '200',
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
      changes: { seq: string; message: ReturnType<typeof message> }[]
      lastSeq: string
      nextSeq: string
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
      changes: [{ seq: '2', message: message('1') }],
      lastSeq: '2',
      nextSeq: '2',
      resetRequired: false,
    })
    await running
    expect(patch).not.toHaveBeenCalled()
  })

  it('caps catch-up at ten pages and replaces retained snapshots', async () => {
    let revision = 0
    const changes = vi.fn(async () => ({
      changes: [],
      lastSeq: '99999',
      nextSeq: String(++revision),
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
