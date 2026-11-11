import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Chat } from '../../entities/chat/model'
import { message } from '../../entities/message/chatRecovery.fixtures'
import type { Message } from '../../entities/message/model'
import type { User } from '../../entities/session/model'
import { ChatKind } from '../../shared/api/generated/socket-vocabulary'
import { useSenderNames } from './useSenderNames'

let dom: JSDOM
let root: Root
let container: HTMLDivElement

const chat: Chat = {
  id: 'chat',
  kind: ChatKind.GROUP,
  members: [],
  memberCount: 0,
  lastSequence: '1',
  name: 'Group',
}

function SenderNames({
  ids,
  lookup,
  selected = chat,
  messages = [],
}: {
  ids: string[]
  lookup: (id: string) => Promise<User>
  selected?: Chat
  messages?: Message[]
}) {
  const names = useSenderNames(selected, messages, lookup, ids)
  return <output>{JSON.stringify(Object.fromEntries(names))}</output>
}

function deferredLookups() {
  const pending = new Map<
    string,
    { resolve: (user: User) => void; reject: (error: Error) => void }
  >()
  const lookup = vi.fn(
    (id: string) =>
      new Promise<User>((resolve, reject) => {
        pending.set(id, { resolve, reject })
      }),
  )
  return {
    lookup,
    resolve: (id: string) => pending.get(id)!.resolve({ id, username: `name-${id}` }),
    reject: (id: string) => pending.get(id)!.reject(new Error('Lookup failed')),
  }
}

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>')
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  dom.window.close()
  vi.unstubAllGlobals()
})

describe('sender name lookups', () => {
  it('limits concurrency to four while letting other senders progress past a stalled lookup', async () => {
    const { lookup, resolve } = deferredLookups()
    const ids = ['a', 'b', 'c', 'd', 'e', 'f']
    await act(async () => root.render(<SenderNames ids={ids} lookup={lookup} />))
    expect(lookup.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'c', 'd'])

    await act(async () => resolve('b'))
    expect(JSON.parse(container.textContent!)).toEqual({ b: 'name-b' })
    expect(lookup.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'c', 'd', 'e'])

    await act(async () => resolve('e'))
    expect(JSON.parse(container.textContent!)).toEqual({ b: 'name-b', e: 'name-e' })
    expect(lookup.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])

    await act(async () => {
      for (const id of ['a', 'c', 'd', 'f']) resolve(id)
    })
    expect(JSON.parse(container.textContent!)).toEqual(
      Object.fromEntries(ids.map((id) => [id, `name-${id}`])),
    )
  })

  it('uses spare workers for newly requested senders and deduplicates pending and cached names', async () => {
    const { lookup, resolve } = deferredLookups()
    await act(async () => root.render(<SenderNames ids={['a', 'a']} lookup={lookup} />))
    await act(async () => root.render(<SenderNames ids={['a', 'b', 'b', 'c']} lookup={lookup} />))
    expect(lookup.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'c'])

    await act(async () => resolve('b'))
    await act(async () =>
      root.render(<SenderNames ids={['a', 'b', 'c', 'd', 'e']} lookup={lookup} />),
    )
    expect(lookup.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(JSON.parse(container.textContent!)).toEqual({ b: 'name-b' })
  })

  it('continues after failure and retries the failed sender when requested inputs change', async () => {
    const { lookup, resolve, reject } = deferredLookups()
    const ids = ['a', 'b', 'c', 'd', 'e']
    await act(async () => root.render(<SenderNames ids={ids} lookup={lookup} />))
    await act(async () => reject('b'))
    expect(lookup.mock.calls.map(([id]) => id)).toEqual(ids)
    await act(async () => resolve('e'))
    expect(JSON.parse(container.textContent!)).toEqual({ e: 'name-e' })

    await act(async () => root.render(<SenderNames ids={[...ids, 'f']} lookup={lookup} />))
    expect(lookup.mock.calls.map(([id]) => id)).toEqual([...ids, 'b'])
    await act(async () => resolve('b'))
    expect(lookup.mock.calls.map(([id]) => id)).toEqual([...ids, 'b', 'f'])
    expect(JSON.parse(container.textContent!)).toEqual({ e: 'name-e', b: 'name-b' })
  })

  it('uses member names and looks up group senders, reply senders, and forwarded senders once', async () => {
    const { lookup, resolve } = deferredLookups()
    const selected = { ...chat, members: [{ id: 'member', username: 'Member' }] }
    const messages = [
      {
        ...message('1'),
        senderId: 'member',
        replySenderId: 'reply',
        forwardedFromUserId: 'forward',
      },
      { ...message('2'), senderId: 'sender' },
    ]
    await act(async () =>
      root.render(
        <SenderNames
          ids={['reply', 'sender']}
          lookup={lookup}
          selected={selected}
          messages={messages}
        />,
      ),
    )
    expect(lookup.mock.calls.map(([id]) => id)).toEqual(['forward', 'reply', 'sender'])
    expect(JSON.parse(container.textContent!)).toEqual({ member: 'Member' })
    await act(async () => resolve('sender'))
    expect(JSON.parse(container.textContent!)).toEqual({ member: 'Member', sender: 'name-sender' })
  })

  it('stops draining queued senders when unmounted with lookups still pending', async () => {
    const { lookup, resolve, reject } = deferredLookups()
    await act(async () =>
      root.render(<SenderNames ids={['a', 'b', 'c', 'd', 'e', 'f']} lookup={lookup} />),
    )
    expect(lookup).toHaveBeenCalledTimes(4)
    await act(async () => root.render(null))
    await act(async () => {
      resolve('a')
      reject('b')
      resolve('c')
      resolve('d')
    })
    expect(lookup).toHaveBeenCalledTimes(4)
    expect(container.textContent).toBe('')
  })
})
