import { isNetworkOnline, subscribeNetwork } from '../lib/network'
import { reconnectDelay } from '../lib/reconnect'
import { ApiError } from './http'
import { decodeSocketEvent, type SocketEvent } from './socket'

export type ConnectionState = 'connecting' | 'connected' | 'offline'

export interface SocketConnectionOptions {
  url: string
  ticket(signal: AbortSignal): Promise<{ token: string; expiresAt: number }>
  onRetryScheduled?(nextRetryAt: number | null): void
  onState(state: ConnectionState): void
  onOpen(socket: WebSocket): void
  onEvent(event: SocketEvent, socket: WebSocket): void
  onClose(): void
  onSessionRevoked(): void
}

export type SocketConnection = (() => void) & { retryNow(): void }

type ConnectionLifecycle =
  | { phase: 'idle' | 'offline' | 'revoked' | 'disposed' }
  | { phase: 'ticket'; controller: AbortController }
  | { phase: 'waiting'; timer: ReturnType<typeof setTimeout> }
  | { phase: 'handshake'; socket: WebSocket; timer: ReturnType<typeof setTimeout> }
  | { phase: 'connected'; socket: WebSocket; timer: ReturnType<typeof setTimeout> }

export function connectSocket(options: SocketConnectionOptions): SocketConnection {
  let lifecycle: ConnectionLifecycle = { phase: 'idle' }
  let ticket: { token: string; expiresAt: number } | null = null
  let attempts = 0

  function transition(next: ConnectionLifecycle): void {
    if ('timer' in lifecycle) clearTimeout(lifecycle.timer)
    if (lifecycle.phase === 'waiting') options.onRetryScheduled?.(null)
    lifecycle = next
  }

  function revokeSession(): void {
    transition({ phase: 'revoked' })
    options.onSessionRevoked()
  }

  function retry(): void {
    if (
      lifecycle.phase === 'disposed' ||
      lifecycle.phase === 'revoked' ||
      lifecycle.phase === 'waiting' ||
      !isNetworkOnline()
    )
      return
    options.onState('offline')
    const delay = reconnectDelay(++attempts)
    options.onRetryScheduled?.(Date.now() + delay)
    transition({
      phase: 'waiting',
      timer: setTimeout(() => {
        transition({ phase: 'idle' })
        void connect()
      }, delay),
    })
  }

  async function connect(): Promise<void> {
    if (!['idle', 'offline'].includes(lifecycle.phase) || !isNetworkOnline()) return
    const request: ConnectionLifecycle = { phase: 'ticket', controller: new AbortController() }
    transition(request)
    options.onState('connecting')
    try {
      const freshTicket =
        !ticket || ticket.expiresAt <= Date.now() / 1000 + 60
          ? await options.ticket(request.controller.signal)
          : ticket
      if (lifecycle !== request || !isNetworkOnline()) return
      ticket = freshTicket
      const active = new WebSocket(options.url, ['messenger', `messenger-ticket.${ticket.token}`])
      const owned = () =>
        (lifecycle.phase === 'handshake' || lifecycle.phase === 'connected') &&
        lifecycle.socket === active
      const closed = (revoked = false) => {
        if (!owned()) return
        transition({ phase: 'idle' })
        options.onClose()
        if (revoked) revokeSession()
        else retry()
      }
      transition({
        phase: 'handshake',
        socket: active,
        timer: setTimeout(() => {
          closed()
          active.close()
        }, 15000),
      })
      active.onopen = () => {
        if (!owned()) return
        transition({
          phase: 'connected',
          socket: active,
          timer: setTimeout(() => {
            attempts = 0
          }, 30000),
        })
        options.onState('connected')
        options.onOpen(active)
      }
      active.onmessage = (event: MessageEvent<unknown>) => {
        if (!owned()) return
        const frame = decodeSocketEvent(event.data)
        if (frame) options.onEvent(frame, active)
      }
      active.onclose = (event: CloseEvent) => {
        closed(event.code === 4003)
      }
      active.onerror = () => {
        if (owned()) active.close()
      }
    } catch (error) {
      if (lifecycle !== request) return
      if (error instanceof ApiError && error.status === 401) revokeSession()
      else retry()
    }
  }

  const unsubscribe = subscribeNetwork(() => {
    if (lifecycle.phase === 'disposed' || lifecycle.phase === 'revoked') return
    if (isNetworkOnline()) {
      if (lifecycle.phase === 'idle' || lifecycle.phase === 'offline') retry()
      return
    }
    if (lifecycle.phase === 'ticket') lifecycle.controller.abort()
    const previous = 'socket' in lifecycle ? lifecycle.socket : null
    transition({ phase: 'offline' })
    options.onRetryScheduled?.(null)
    previous?.close()
    if (previous) options.onClose()
    options.onState('offline')
  })
  if (isNetworkOnline()) void connect()
  else {
    transition({ phase: 'offline' })
    options.onState('offline')
  }
  const close = () => {
    if (lifecycle.phase === 'disposed') return
    if (lifecycle.phase === 'ticket') lifecycle.controller.abort()
    const previous = 'socket' in lifecycle ? lifecycle.socket : null
    transition({ phase: 'disposed' })
    unsubscribe()
    options.onRetryScheduled?.(null)
    previous?.close()
    options.onClose()
  }
  return Object.assign(close, {
    retryNow() {
      if (!['idle', 'offline', 'waiting'].includes(lifecycle.phase) || !isNetworkOnline()) return
      transition({ phase: 'idle' })
      options.onRetryScheduled?.(null)
      void connect()
    },
  })
}
