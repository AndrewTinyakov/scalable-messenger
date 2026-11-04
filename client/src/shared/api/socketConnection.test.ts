import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './http'
import { connectSocket, type SocketConnectionOptions } from './socketConnection'

class TestSocket {
  onopen: (() => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  close = vi.fn()
}

function fixture(
  ticket = vi.fn(async () => ({ token: 'ticket', expiresAt: Date.now() / 1000 + 3600 })),
) {
  const sockets: TestSocket[] = []
  vi.stubGlobal('WebSocket', function () {
    const socket = new TestSocket()
    sockets.push(socket)
    return socket
  })
  const options: SocketConnectionOptions = {
    url: 'ws://localhost/ws',
    ticket,
    onState: vi.fn(),
    onOpen: vi.fn(),
    onEvent: vi.fn(),
    onClose: vi.fn(),
    onSessionRevoked: vi.fn(),
  }
  return { sockets, options, ticket, start: () => connectSocket(options) }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('socket connection lifecycle', () => {
  it('does not reopen a revoked session when the network changes', async () => {
    vi.useFakeTimers()
    let online = true
    const network = Object.assign(new EventTarget(), {
      navigator: {
        get onLine() {
          return online
        },
      },
    })
    vi.stubGlobal('window', network)
    const test = fixture(vi.fn().mockRejectedValue(new ApiError(401, 'Session revoked')))
    const close = test.start()
    await Promise.resolve()
    expect(test.options.onSessionRevoked).toHaveBeenCalledOnce()
    online = false
    network.dispatchEvent(new Event('offline'))
    online = true
    network.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(60000)
    expect(test.ticket).toHaveBeenCalledOnce()
    expect(test.sockets).toHaveLength(0)
    close()
  })

  it('pauses offline without retrying and reconnects once when the network returns', async () => {
    vi.useFakeTimers()
    let online = true
    const network = Object.assign(new EventTarget(), {
      navigator: {
        get onLine() {
          return online
        },
      },
    })
    vi.stubGlobal('window', network)
    const test = fixture()
    const close = test.start()
    await Promise.resolve()
    const first = test.sockets[0]
    first.onopen?.()
    online = false
    network.dispatchEvent(new Event('offline'))
    expect(test.options.onState).toHaveBeenLastCalledWith('offline')
    expect(first.close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60000)
    expect(test.sockets).toHaveLength(1)
    online = true
    network.dispatchEvent(new Event('online'))
    network.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(test.sockets).toHaveLength(2)
    test.sockets[1].onopen?.()
    expect(test.options.onState).toHaveBeenLastCalledWith('connected')
    first.onclose?.({ code: 4003 })
    expect(test.options.onSessionRevoked).not.toHaveBeenCalled()
    close()
    network.dispatchEvent(new Event('online'))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits for the network before requesting a ticket and ignores superseded ticket failures', async () => {
    vi.useFakeTimers()
    let online = false
    const network = Object.assign(new EventTarget(), {
      navigator: {
        get onLine() {
          return online
        },
      },
    })
    vi.stubGlobal('window', network)
    let reject!: (error: Error) => void
    const test = fixture(
      vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((_, fail) => {
              reject = fail
            }),
        )
        .mockResolvedValue({ token: 'fresh', expiresAt: Date.now() / 1000 + 3600 }),
    )
    const close = test.start()
    await vi.advanceTimersByTimeAsync(60000)
    expect(test.ticket).not.toHaveBeenCalled()
    online = true
    network.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(test.ticket).toHaveBeenCalledOnce()
    online = false
    network.dispatchEvent(new Event('offline'))
    online = true
    network.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(2000)
    expect(test.sockets).toHaveLength(1)
    reject(new ApiError(401, 'Old ticket request'))
    await Promise.resolve()
    expect(test.options.onSessionRevoked).not.toHaveBeenCalled()
    close()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reconnects after a stalled handshake and ignores its late open event', async () => {
    vi.useFakeTimers()
    const test = fixture()
    const close = test.start()
    await Promise.resolve()
    const stalled = test.sockets[0]
    await vi.advanceTimersByTimeAsync(15000)
    expect(stalled.close).toHaveBeenCalledOnce()
    expect(test.options.onState).toHaveBeenLastCalledWith('offline')
    expect(test.options.onClose).toHaveBeenCalledOnce()
    stalled.onopen?.()
    expect(test.options.onOpen).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5000)
    expect(test.sockets).toHaveLength(2)
    test.sockets[1].onopen?.()
    expect(test.options.onState).toHaveBeenLastCalledWith('connected')
    close()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores an authentication failure after the owning session is disposed', async () => {
    let reject!: (error: Error) => void
    const test = fixture(
      vi.fn(
        () =>
          new Promise<never>((_, fail) => {
            reject = fail
          }),
      ),
    )
    const close = test.start()
    close()
    reject(new ApiError(401, 'Session expired'))
    await Promise.resolve()
    expect(test.options.onSessionRevoked).not.toHaveBeenCalled()
    expect(test.sockets).toEqual([])
  })

  it('ignores late callbacks from a socket that has been replaced', async () => {
    vi.useFakeTimers()
    const test = fixture()
    const close = test.start()
    await Promise.resolve()
    const first = test.sockets[0]
    first.onopen?.()
    const oldClose = first.onclose!
    const oldOpen = first.onopen!
    oldClose({ code: 1006 })
    await vi.advanceTimersByTimeAsync(5000)
    expect(test.sockets).toHaveLength(2)
    test.sockets[1].onopen?.()
    const opens = vi.mocked(test.options.onOpen).mock.calls.length
    const closures = vi.mocked(test.options.onClose).mock.calls.length
    oldClose({ code: 4003 })
    oldOpen()
    expect(test.options.onSessionRevoked).not.toHaveBeenCalled()
    expect(test.options.onOpen).toHaveBeenCalledTimes(opens)
    expect(test.options.onClose).toHaveBeenCalledTimes(closures)
    close()
  })

  it('reports an invalid socket URL as offline and retries without an unhandled rejection', async () => {
    vi.useFakeTimers()
    const test = fixture()
    vi.stubGlobal('WebSocket', function () {
      throw new SyntaxError('Invalid URL')
    })
    const close = test.start()
    await Promise.resolve()
    expect(test.options.onState).toHaveBeenLastCalledWith('offline')
    await vi.advanceTimersByTimeAsync(60000)
    expect(test.options.onState).toHaveBeenLastCalledWith('offline')
    expect(test.options.onSessionRevoked).not.toHaveBeenCalled()
    close()
  })
})
