import { JSDOM } from 'jsdom'
import { act, useState } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Chat } from '../../entities/chat/model'
import type { Session, User } from '../../entities/session/model'
import { ChatKind } from '../../shared/api/generated/socket-vocabulary'
import { GroupMembersDialog } from './GroupMembersDialog'

const alice = { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', username: 'alice' }
const bob = { id: '01ARZ3NDEKTSV4RRFFQ69G5FAW', username: 'bob' }
const carol = { id: '01ARZ3NDEKTSV4RRFFQ69G5FAX', username: 'carol' }
const group: Chat = {
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAY',
  kind: ChatKind.GROUP,
  name: 'Weekend plans',
  ownerId: alice.id,
  members: [],
  memberCount: 2,
  lastSequence: '0',
}
const membersPath = `/api/v1/chats/${group.id}/members`
const onClose = vi.fn()

interface Request {
  url: URL
  method: string
  options: RequestInit
}

let dom: JSDOM
let root: Root
let container: HTMLDivElement
let requests: Request[]
let members: User[]
let serverChat: Chat
let respond: (request: Request) => Response | undefined

function Harness({ user }: { user: User }) {
  const [chat, setChat] = useState(group)
  const session: Session = { user, deviceId: 'device' }
  return (
    <>
      <output aria-label="Chat member count">{chat.memberCount}</output>
      <button onClick={() => setChat(serverChat)}>Refresh chat metadata</button>
      <GroupMembersDialog chat={chat} session={session} onClose={onClose} onUpdated={setChat} />
    </>
  )
}

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const { createRoot } = await import('react-dom/client')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  requests = []
  members = [alice, bob]
  serverChat = { ...group }
  respond = () => undefined
  onClose.mockClear()
  vi.stubGlobal('fetch', async (input: string, options: RequestInit = {}) => {
    const request = { url: new URL(input), method: options.method ?? 'GET', options }
    requests.push(request)
    const response = respond(request)
    if (response) return response
    if (request.method === 'GET' && request.url.pathname === `/api/v1/chats/${group.id}`)
      return Response.json(serverChat)
    if (request.method === 'GET' && request.url.pathname === membersPath)
      return Response.json({ members, nextCursor: null })
    throw new Error(`Unexpected request: ${request.method} ${request.url}`)
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  dom.window.close()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function render(user = alice) {
  await act(async () => root.render(<Harness user={user} />))
}

function button(label: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) => (element.getAttribute('aria-label') ?? element.textContent) === label,
  )
  expect(found, `Button ${label}`).toBeDefined()
  return found!
}

async function click(label: string) {
  await act(async () => button(label).click())
}

function memberRows() {
  return [...container.querySelectorAll('[aria-label="Group members"] > li')]
}

function mutations() {
  return requests.filter((request) => request.method !== 'GET')
}

async function search(query: string) {
  vi.useFakeTimers()
  const input = container.querySelector<HTMLInputElement>('[aria-label="Find people to add"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      query,
    )
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250)
  })
}

describe('group membership management', () => {
  it('updates an open list when another session replaces a member without changing the count', async () => {
    serverChat = { ...group, members: [alice, bob] }
    await render()
    expect(memberRows().map((row) => row.textContent)).toEqual([
      expect.stringContaining('alice'),
      expect.stringContaining('bob'),
    ])
    members = [alice, carol]
    serverChat = { ...group, members }
    await click('Refresh chat metadata')
    expect(memberRows()).toHaveLength(2)
    expect(memberRows()[1].textContent).toContain('carol')
    expect(container.querySelector('[aria-label="Remove bob"]')).toBeNull()
    expect(container.querySelector('[aria-label="Chat member count"]')?.textContent).toBe('2')
  })
  it('loads members for the owner and protects the owner from removal', async () => {
    await render()

    expect(container.querySelector('h2')?.textContent).toBe('Group members')
    expect(memberRows()).toHaveLength(2)
    expect(memberRows()[0].textContent).toContain('alice')
    expect(memberRows()[0].textContent).toContain('Owner')
    expect(memberRows()[0].querySelector('button')).toBeNull()
    expect(button('Remove bob').disabled).toBe(false)
    expect(container.querySelector('[aria-label="Find people to add"]')).not.toBeNull()
    expect(container.textContent).toContain('2 members')
    expect(mutations()).toEqual([])
  })

  it('searches for new people, posts the selection, and refreshes members and the parent count', async () => {
    respond = ({ url, method, options }) => {
      if (url.pathname === '/api/v1/users') return Response.json([alice, bob, carol])
      if (url.pathname === membersPath && method === 'POST') {
        expect(JSON.parse(options.body as string)).toEqual({ memberIds: [carol.id] })
        members = [alice, bob, carol]
        serverChat = { ...group, memberCount: 3 }
        return new Response(null, { status: 204 })
      }
    }
    await render()
    await search(' car ')

    expect(
      requests.find(({ url }) => url.pathname === '/api/v1/users')?.url.searchParams.get('query'),
    ).toBe('car')
    expect(container.querySelector('[aria-label="Add alice"]')).toBeNull()
    expect(container.querySelector('[aria-label="Add bob"]')).toBeNull()
    await click('Add carol')

    expect(mutations()).toHaveLength(1)
    expect(memberRows()).toHaveLength(3)
    expect(memberRows()[2].textContent).toContain('carol')
    expect(container.textContent).toContain('3 members')
    expect(container.querySelector('[aria-label="Chat member count"]')?.textContent).toBe('3')
    expect(
      container.querySelector<HTMLInputElement>('[aria-label="Find people to add"]')?.value,
    ).toBe('')
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Member list updated.')
  })

  it('requires confirmation before removal and refreshes the list and count after deleting', async () => {
    respond = ({ url, method }) => {
      if (url.pathname === `${membersPath}/${bob.id}` && method === 'DELETE') {
        members = [alice]
        serverChat = { ...group, memberCount: 1 }
        return new Response(null, { status: 204 })
      }
    }
    await render()
    await click('Remove bob')
    expect(container.textContent).toContain('Remove bob from this group?')
    expect(mutations()).toEqual([])
    await click('Cancel')
    expect(container.textContent).not.toContain('Remove bob from this group?')
    expect(memberRows()).toHaveLength(2)
    await click('Remove bob')
    await click('Confirm removing bob')

    expect(mutations().map(({ method, url }) => [method, url.pathname])).toEqual([
      ['DELETE', `${membersPath}/${bob.id}`],
    ])
    expect(memberRows()).toHaveLength(1)
    expect(memberRows()[0].textContent).toContain('alice')
    expect(container.textContent).toContain('1 member')
    expect(container.textContent).not.toContain('Remove bob from this group?')
    expect(container.querySelector('[aria-label="Chat member count"]')?.textContent).toBe('1')
  })

  it('lets a nonowner read the member list without mutation controls', async () => {
    await render(bob)

    expect(memberRows()).toHaveLength(2)
    expect(memberRows()[0].textContent).toContain('Owner')
    expect(memberRows()[1].textContent).toContain('You')
    expect(container.textContent).toContain('Only the group owner can add or remove members.')
    expect(container.querySelector('input')).toBeNull()
    expect(container.querySelector('button[aria-label^="Remove "]')).toBeNull()
    expect(container.querySelector('button[aria-label^="Add "]')).toBeNull()
    expect(mutations()).toEqual([])
  })

  it('merges cursor pages without duplicating existing members', async () => {
    serverChat = { ...group, memberCount: 3 }
    respond = ({ url }) => {
      if (url.pathname !== membersPath) return
      return url.searchParams.has('afterUserId')
        ? Response.json({ members: [bob, carol], nextCursor: null })
        : Response.json({ members: [alice, bob], nextCursor: bob.id })
    }
    await render()
    expect(memberRows()).toHaveLength(2)
    await click('Load more members')

    expect(
      requests
        .filter(({ url }) => url.pathname === membersPath)
        .map(({ url }) => url.searchParams.get('afterUserId')),
    ).toEqual([null, bob.id])
    expect(memberRows()).toHaveLength(3)
    expect(memberRows()[0].textContent).toContain('alice')
    expect(memberRows()[1].textContent).toContain('bob')
    expect(memberRows()[2].textContent).toContain('carol')
    expect(container.textContent).not.toContain('Load more members')
  })

  it('shows a failed load and recovers when the user refreshes', async () => {
    let failed = false
    respond = ({ url }) => {
      if (url.pathname === membersPath && !failed) {
        failed = true
        return Response.json({ message: 'Members temporarily unavailable' }, { status: 503 })
      }
    }
    await render()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Members temporarily unavailable',
    )
    expect(memberRows()).toHaveLength(0)
    await click('Refresh members')

    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(memberRows()).toHaveLength(2)
    expect(button('Remove bob').disabled).toBe(false)
  })
})
