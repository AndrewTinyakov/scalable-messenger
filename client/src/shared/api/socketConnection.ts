import { reconnectDelay } from '../lib/reconnect'
import { ApiError } from './http'
import { decodeSocketEvent, type SocketEvent } from './socket'

export type ConnectionState = 'connecting' | 'connected' | 'offline'

export interface SocketConnectionOptions {
  url: string
  ticket(): Promise<{ token: string; expiresAt: number }>
  onState(state: ConnectionState): void
  onOpen(socket: WebSocket): void
  onEvent(event: SocketEvent, socket: WebSocket): void
  onClose(): void
  onSessionRevoked(): void
}

export function connectSocket(options: SocketConnectionOptions): () => void {
  let disposed = false
  let socket: WebSocket | null = null
  let ticket: { token: string; expiresAt: number } | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined
  let stableTimer: ReturnType<typeof setTimeout> | undefined
  let attempts = 0

  function retry(): void {
    if (disposed) return
    options.onState('offline')
    reconnectTimer = setTimeout(() => {
      void connect()
    }, reconnectDelay(++attempts))
  }

  async function connect(): Promise<void> {
    if (disposed) return
    options.onState('connecting')
    try {
      if (!ticket || ticket.expiresAt <= Date.now() / 1000 + 60) ticket = await options.ticket()
      if (disposed) return
      const active = new WebSocket(options.url, ['messenger', `messenger-ticket.${ticket.token}`])
      socket = active
      const owned = () => !disposed && socket === active
      const closed = (revoked = false) => {
        if (!owned()) return
        socket = null
        clearTimeout(handshakeTimer)
        clearTimeout(stableTimer)
        options.onClose()
        if (revoked) options.onSessionRevoked()
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
      if (disposed) return
      if (error instanceof ApiError && error.status === 401) options.onSessionRevoked()
      else retry()
    }
  }

  void connect()
  return () => {
    if (disposed) return
    disposed = true
    clearTimeout(reconnectTimer)
    clearTimeout(handshakeTimer)
    clearTimeout(stableTimer)
    socket?.close()
    socket = null
    options.onClose()
  }
}
