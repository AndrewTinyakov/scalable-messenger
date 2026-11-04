import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from './http'

const session = {
  user: { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', username: 'alice' },
  deviceId: 'device',
}
const authenticated = api.forSession(session)

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('HTTP transport', () => {
  it('loads the requested author and rejects a response for another user', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(session.user))
    vi.stubGlobal('fetch', fetch)
    await expect(authenticated.user(session.user.id)).resolves.toEqual(session.user)
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/v1/users/${session.user.id}`),
      expect.objectContaining({
        credentials: 'include',
        headers: expect.objectContaining({ 'X-Messenger-User': session.user.id }),
      }),
    )
    await expect(authenticated.user('01ARZ3NDEKTSV4RRFFQ69G5FAW')).rejects.toThrow(
      'Invalid response from server',
    )
  })
  it('validates group member pages and preserves the exclusive user cursor', async () => {
    const cursor = '01ARZ3NDEKTSV4RRFFQ69G5FAW'
    const page = { members: [session.user], nextCursor: cursor }
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(page))
    vi.stubGlobal('fetch', fetch)
    await expect(authenticated.groupMembers('chat/id', cursor)).resolves.toEqual(page)
    const url = new URL(fetch.mock.calls[0][0] as string, 'http://localhost')
    expect(url.pathname).toBe('/api/v1/chats/chat%2Fid/members')
    expect(url.searchParams.get('afterUserId')).toBe(cursor)
    expect(url.searchParams.get('limit')).toBe('50')
    for (const malformed of [
      { ...page, nextCursor: 'not-a-user-id' },
      { members: page.members },
      { ...page, members: [{ id: cursor, username: '' }] },
      { ...page, unexpected: true },
    ]) {
      fetch.mockResolvedValueOnce(Response.json(malformed))
      await expect(authenticated.groupMembers('chat')).rejects.toThrow(
        'Invalid response from server',
      )
    }
  })

  it('removes a member through the authenticated mutation transport', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetch)
    await expect(authenticated.removeGroupMember('chat/id', 'user/id')).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/chat%2Fid/members/user%2Fid'),
      expect.objectContaining({
        method: 'DELETE',
        credentials: 'include',
        headers: expect.objectContaining({
          'X-Messenger-CSRF': '1',
          'X-Messenger-User': session.user.id,
          'X-Messenger-Device': session.deviceId,
        }),
      }),
    )
  })
  it('releases a stalled authenticated request so recovery can retry', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          })
        }),
    )
    vi.stubGlobal('fetch', fetch)
    const failed = expect(authenticated.chats()).rejects.toThrow('Request timed out. Try again.')
    await vi.advanceTimersByTimeAsync(15000)
    await failed
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps authentication requests out of caches and rejects credential redirects', async () => {
    const session = {
      user: { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', username: 'alice' },
      deviceId: 'device',
    }
    const fetch = vi.fn(async () => new Response(JSON.stringify(session), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    await expect(api.login('alice', 'password', 'device')).resolves.toEqual(session)
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        cache: 'no-store',
        redirect: 'error',
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Messenger-CSRF': '1' },
      }),
    )
  })

  it('restores the cookie session without a stale expected identity', async () => {
    const status = {
      userId: session.user.id,
      username: session.user.username,
      deviceId: session.deviceId,
    }
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(status)))
    vi.stubGlobal('fetch', fetch)
    await expect(api.session()).resolves.toEqual(status)
    expect(fetch.mock.calls[0][1]).toEqual(
      expect.objectContaining({ credentials: 'include', headers: {} }),
    )
  })

  it('captures the identity of the caller even when another tab switches the session', async () => {
    const identity = { user: { ...session.user }, deviceId: session.deviceId }
    const original = api.forSession(identity)
    identity.user.id = '01ARZ3NDEKTSV4RRFFQ69G5FAW'
    identity.deviceId = 'other-device'
    const switched = api.forSession(identity)
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(JSON.stringify({ chats: [], nextCursor: null })),
    )
    vi.stubGlobal('fetch', fetch)
    await original.chats()
    await switched.chats()
    expect(fetch.mock.calls[0][1]?.headers).toEqual({
      'X-Messenger-User': session.user.id,
      'X-Messenger-Device': session.deviceId,
    })
    expect(fetch.mock.calls[1][1]?.headers).toEqual({
      'X-Messenger-User': identity.user.id,
      'X-Messenger-Device': identity.deviceId,
    })
  })

  it('rejects authentication responses that expose a session credential', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ...session, token: 'a'.repeat(43) }))),
    )
    await expect(api.login('alice', 'password', 'device')).rejects.toThrow(
      'Invalid response from server',
    )
  })

  it('uses the same protected transport for authenticated operations without a response body', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetch)
    await expect(authenticated.logout()).resolves.toBeUndefined()
    await expect(authenticated.addGroupMembers('chat/id', ['member'])).resolves.toBeUndefined()
    for (const [, options] of fetch.mock.calls)
      expect(options).toEqual(
        expect.objectContaining({
          cache: 'no-store',
          redirect: 'error',
          credentials: 'include',
          headers: expect.objectContaining({
            'X-Messenger-CSRF': '1',
            'X-Messenger-User': session.user.id,
            'X-Messenger-Device': session.deviceId,
          }),
        }),
      )
    expect(fetch).toHaveBeenLastCalledWith(
      expect.stringContaining('/chat%2Fid/members'),
      expect.any(Object),
    )
  })

  it('reports server error details consistently for no-content operations', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ detail: 'Membership changed' }), { status: 403 }),
      ),
    )
    const result = authenticated.addGroupMembers('chat', ['member'])
    await expect(result).rejects.toBeInstanceOf(ApiError)
    await expect(result).rejects.toThrow('Membership changed')
  })

  it('rejects malformed history before it can enter recovery state', async () => {
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              messages: [
                {
                  id,
                  chatId: id,
                  sequence: 'not-a-sequence',
                  senderId: id,
                  body: 'Hello',
                  createdAt: '2026-09-28T10:00:00Z',
                },
              ],
              nextSequence: '1',
              hasMore: false,
            }),
            { status: 200 },
          ),
      ),
    )
    await expect(authenticated.latestMessages(id)).rejects.toThrow('Invalid response from server')
  })

  it('rejects history for another chat and malformed saved send results', async () => {
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    const other = '01ARZ3NDEKTSV4RRFFQ69G5FAW'
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            messages: [
              {
                id,
                chatId: other,
                sequence: '1',
                senderId: id,
                body: 'Hello',
                createdAt: '2026-09-28T10:00:00Z',
              },
            ],
            nextSequence: '1',
            hasMore: false,
          }),
          { status: 200 },
        ),
    )
    vi.stubGlobal('fetch', fetch)
    await expect(authenticated.latestMessages(id)).rejects.toThrow('Invalid response from server')
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'SAVED', chatId: id, messageId: 'bad-id' }), {
        status: 200,
      }),
    )
    await expect(authenticated.sendStatus(id)).rejects.toThrow('Invalid response from server')
  })

  it('rejects an invalid chat cursor before another page is requested', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ chats: [], nextCursor: 'bad/cursor' }), { status: 200 }),
      ),
    )
    await expect(authenticated.chats()).rejects.toThrow('Invalid response from server')
  })

  it('accepts uppercase chat kinds and rejects lowercase wire values', async () => {
    const id = session.user.id
    for (const kind of ['DIRECT', 'GROUP', 'direct', 'group']) {
      const chat = { id, kind, members: [], memberCount: 1, lastSequence: '0' }
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json(chat)),
      )
      if (kind === 'DIRECT' || kind === 'GROUP') {
        await expect(authenticated.chat(id)).resolves.toEqual(chat)
      } else {
        await expect(authenticated.chat(id)).rejects.toThrow('Invalid response from server')
      }
    }
  })

  it('accepts each uppercase send lookup result with its required fields', async () => {
    const id = session.user.id
    for (const result of [
      { status: 'UNKNOWN' },
      { status: 'SAVED', chatId: id, messageId: id, sequence: '9007199254740993' },
      { status: 'REJECTED', chatId: id, reason: 'NOT_A_MEMBER' },
    ]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json(result)),
      )
      await expect(authenticated.sendStatus(id)).resolves.toEqual(result)
    }
  })

  it('rejects send statuses that cannot be committed request results', async () => {
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    for (const result of [
      { status: 'unknown' },
      { status: 'saved', chatId: id, messageId: id, sequence: '1' },
      { status: 'rejected', reason: 'NOT_A_MEMBER' },
      { status: 'SAVED', chatId: id, messageId: id },
      { status: 'SAVED', chatId: id, messageId: id, sequence: '1', reason: 'NOT_A_MEMBER' },
      { status: 'REJECTED' },
      { status: 'REJECTED', reason: 'MAYBE' },
      { status: 'REJECTED', reason: 'NOT_A_MEMBER', messageId: id },
      { status: 'REJECTED', reason: 'NOT_A_MEMBER', sequence: '1' },
      { status: 'UNKNOWN', chatId: id },
      { status: 'UNKNOWN', reason: 'NOT_A_MEMBER' },
    ]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify(result), { status: 200 })),
      )
      await expect(authenticated.sendStatus(id)).rejects.toThrow('Invalid response from server')
    }
  })
})
