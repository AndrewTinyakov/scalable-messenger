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
  it('preserves a newer edit body while respecting the response quote authorization', async () => {
    const requests = new HistoryRequests()
    const reply = {
      ...message('2'),
      replyToMessageId: 'message-1',
      replySenderId: 'sender',
      replyBody: 'erased quote secret',
      replyVersion: '1',
      replyDeleted: false,
    }
    let release!: (page: {
      messages: Message[]
      mutationRevision: string
      visibilityRevision: string
    }) => void
    const loading = requests.run(
      'chat',
      () =>
        new Promise<{ messages: Message[]; mutationRevision: string; visibilityRevision: string }>(
          (resolve) => {
            release = resolve
          },
        ),
      (page) => page.messages,
    )
    requests.patch('chat', [{ ...reply, body: 'newer edit body', messageVersion: '3' }])
    requests.observe('chat', { mutationRevision: '1', visibilityRevision: '1' })
    release({
      messages: [
        {
          ...reply,
          body: 'older edit body',
          messageVersion: '2',
          replySenderId: null,
          replyBody: null,
          replyVersion: null,
          replyDeleted: null,
        },
      ],
      mutationRevision: '1',
      visibilityRevision: '1',
    })
    expect(await loading).toEqual([
      expect.objectContaining({
        body: 'newer edit body',
        messageVersion: '3',
        replyBody: null,
        replyVersion: null,
      }),
    ])
  })

  it('filters non-authoritative overlay identities before they can hydrate a quote', async () => {
    const requests = new HistoryRequests()
    const delayed = delayedPage()
    const reply = {
      ...message('2'),
      replyToMessageId: 'message-1',
      replySenderId: 'sender',
      replyBody: 'canonical visible preview',
      replyVersion: '1',
      replyDeleted: false,
    }
    const loading = requests.run(
      'chat',
      () => delayed.promise,
      (page) => page.messages,
    )
    requests.patch('chat', [
      { ...message('1'), body: 'unproven target secret', messageVersion: '4' },
    ])
    delayed.resolve({ messages: [reply] })
    expect(await loading).toEqual([reply])
  })
  it('keeps an in-flight revision fence after thousands of other chat hints', async () => {
    const requests = new HistoryRequests()
    let release!: (page: {
      messages: Message[]
      mutationRevision: string
      visibilityRevision: string
    }) => void
    const install = (page: { messages: Message[] }) => page.messages
    const loading = requests.run(
      'selected',
      () =>
        new Promise<{ messages: Message[]; mutationRevision: string; visibilityRevision: string }>(
          (resolve) => {
            release = resolve
          },
        ),
      install,
    )
    requests.observe('selected', { mutationRevision: '3', visibilityRevision: '2' })
    for (let index = 0; index < 2000; index += 1)
      requests.observe(`other-${index}`, { mutationRevision: '1', visibilityRevision: '1' })
    requests.observe('selected', { mutationRevision: '1', visibilityRevision: '1' })
    release({ messages: [message('1')], mutationRevision: '2', visibilityRevision: '1' })
    expect(await loading).toBeUndefined()
    expect(
      await requests.run(
        'selected',
        async () => ({ messages: [message('2')], mutationRevision: '3', visibilityRevision: '2' }),
        install,
      ),
    ).toEqual([message('2')])
  })
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
      replyDeleted: false,
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
    first.resolve({ messages: [target, reply] })
    expect(await initial).toEqual([
      expect.objectContaining({ body: 'new target', messageVersion: '3' }),
      expect.objectContaining({ replyBody: 'new target', replyVersion: '3' }),
    ])
    requests.patch('chat', [{ ...target, body: 'latest target', messageVersion: '4' }])
    second.resolve({ messages: [target, reply] })
    expect(await later).toEqual([
      expect.objectContaining({ body: 'latest target', messageVersion: '4' }),
      expect.objectContaining({ replyBody: 'latest target', replyVersion: '4' }),
    ])
    expect(
      await requests.run(
        'chat',
        async () => ({ messages: [target, reply] }),
        (page) => page.messages,
      ),
    ).toEqual([target, reply])
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
