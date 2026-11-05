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

export function connectSocket(options: SocketConnectionOptions): SocketConnection {
  let disposed = false
  let socket: WebSocket | null = null
  let ticket: { token: string; expiresAt: number } | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined
  let stableTimer: ReturnType<typeof setTimeout> | undefined
  let attempts = 0
  let generation = 0
  let ticketController: AbortController | undefined
  let connecting = false
  let revoked = false

  function clearTimers(): void {
    clearTimeout(reconnectTimer)
    clearTimeout(handshakeTimer)
    clearTimeout(stableTimer)
    reconnectTimer = undefined
    options.onRetryScheduled?.(null)
  }

  function revokeSession(): void {
    revoked = true
    options.onSessionRevoked()
  }

  function retry(): void {
    if (disposed || revoked || !isNetworkOnline() || reconnectTimer !== undefined) return
    options.onState('offline')
    const delay = reconnectDelay(++attempts)
    options.onRetryScheduled?.(Date.now() + delay)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      options.onRetryScheduled?.(null)
      void connect()
    }, delay)
  }

  async function connect(): Promise<void> {
    if (disposed || revoked || connecting || socket || !isNetworkOnline()) return
    ticketController = new AbortController()
    connecting = true
    const current = ++generation
    const currentAttempt = () => !disposed && current === generation
    options.onState('connecting')
    try {
      const freshTicket =
        !ticket || ticket.expiresAt <= Date.now() / 1000 + 60
          ? await options.ticket(ticketController.signal)
          : ticket
      if (!currentAttempt() || !isNetworkOnline()) return
      ticket = freshTicket
      const active = new WebSocket(options.url, ['messenger', `messenger-ticket.${ticket.token}`])
      socket = active
      const owned = () => !disposed && socket === active
      const closed = (revoked = false) => {
        if (!owned()) return
        socket = null
        clearTimeout(handshakeTimer)
        clearTimeout(stableTimer)
        options.onClose()
        if (revoked) revokeSession()
        else retry()
      }
      handshakeTimer = setTimeout(() => {
        closed()
        active.close()
      }, 15000)
      active.onopen = () => {
        if (!owned()) return
        clearTimeout(handshakeTimer)
        stableTimer = setTimeout(() => {
          attempts = 0
        }, 30000)
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
      if (!currentAttempt()) return
      if (error instanceof ApiError && error.status === 401) revokeSession()
      else retry()
    } finally {
      if (currentAttempt()) connecting = false
    }
  }

  const unsubscribe = subscribeNetwork(() => {
    if (disposed || revoked) return
    if (isNetworkOnline()) {
      if (!socket && !connecting) retry()
      return
    }
    ticketController?.abort()
    generation += 1
    connecting = false
    clearTimers()
    const previous = socket
    socket = null
    previous?.close()
    if (previous) options.onClose()
    options.onState('offline')
  })
  if (isNetworkOnline()) void connect()
  else options.onState('offline')
  const close = () => {
    if (disposed) return
    ticketController?.abort()
    disposed = true
    unsubscribe()
    clearTimers()
    socket?.close()
    socket = null
    options.onClose()
  }
  return Object.assign(close, {
    retryNow() {
      if (disposed || revoked || socket || connecting || !isNetworkOnline()) return
      clearTimeout(reconnectTimer)
      reconnectTimer = undefined
      options.onRetryScheduled?.(null)
      void connect()
    },
  })
}
