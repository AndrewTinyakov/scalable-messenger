import { describe, expect, it } from 'vitest'
import { message } from './chatRecovery.fixtures'
import { HistoryRequests } from './historyRequests'
import type { Message } from './model'

function delayedPage() {
  let resolve!: (page: { messages: Message[] }) => void
  const promise = new Promise<{ messages: Message[] }>((release) => {
    resolve = release
  })
  return { promise, resolve }
}

describe('pending history requests', () => {
  it('keeps independent quote versions and releases settled mutations', async () => {
    const requests = new HistoryRequests()
    const first = delayedPage()
    const second = delayedPage()
    const target = { ...message('1'), body: 'old target', messageVersion: '1' }
    const reply = {
      ...message('2'),
      replyToMessageId: target.id,
      replySenderId: target.senderId,
      replyBody: target.body,
      replyVersion: '1',
    }
    const initial = requests.run(
      'chat',
      () => first.promise,
      (page) => page.messages,
    )
    requests.patch('chat', [{ ...target, body: 'new target', messageVersion: '3' }])
    const later = requests.run(
      'chat',
      () => second.promise,
      (page) => page.messages,
    )
    requests.patch('chat', [{ ...target, body: 'middle target', messageVersion: '2' }])
    first.resolve({ messages: [reply] })
    expect(await initial).toEqual([
      expect.objectContaining({ replyBody: 'new target', replyVersion: '3' }),
    ])
    requests.patch('chat', [{ ...target, body: 'latest target', messageVersion: '4' }])
    second.resolve({ messages: [reply] })
    expect(await later).toEqual([
      expect.objectContaining({ replyBody: 'latest target', replyVersion: '4' }),
    ])
    expect(
      await requests.run(
        'chat',
        async () => ({ messages: [reply] }),
        (page) => page.messages,
      ),
    ).toEqual([reply])
  })

  it('rejects an overflowed snapshot without installing it and permits a fresh request', async () => {
    const requests = new HistoryRequests()
    const delayed = delayedPage()
    let installed = false
    const loading = requests.run(
      'chat',
      () => delayed.promise,
      () => {
        installed = true
      },
    )
    requests.patch(
      'chat',
      Array.from({ length: 501 }, (_, index) => message(String(index + 1))),
    )
    delayed.resolve({ messages: [message('1')] })
    await expect(loading).rejects.toThrow('History changed too much')
    expect(installed).toBe(false)
    expect(
      await requests.run(
        'chat',
        async () => ({ messages: [message('1')] }),
        (page) => page.messages,
      ),
    ).toEqual([message('1')])
  })

  it.each([undefined, 'chat'])(
    'discards cancelled requests and frees their capacity for %s',
    async (chatId) => {
      const requests = new HistoryRequests()
      const delayed = delayedPage()
      let installed = false
      const loading = Array.from({ length: 16 }, () =>
        requests.run(
          'chat',
          () => delayed.promise,
          () => {
            installed = true
          },
        ),
      )
      await expect(
        requests.run(
          'chat',
          async () => ({ messages: [] }),
          () => {},
        ),
      ).rejects.toThrow('Too many pending history requests')
      requests.patch('chat', [{ ...message('1'), messageVersion: '3' }])
      requests.cancel(chatId)
      expect(
        await requests.run(
          'chat',
          async () => ({ messages: [message('1')] }),
          (page) => page.messages,
        ),
      ).toEqual([message('1')])
      delayed.resolve({ messages: [message('1')] })
      expect(await Promise.all(loading)).toEqual(Array(16).fill(undefined))
      expect(installed).toBe(false)
    },
  )
})
