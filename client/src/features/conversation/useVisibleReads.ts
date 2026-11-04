import { useEffect, useRef, type RefObject } from 'react'
import type { Message } from '../../entities/message/model'

export function isReadVisible(row: DOMRect, viewport: DOMRect): boolean {
  if (row.height <= 0 || viewport.height <= 0) return false
  const visible = Math.max(
    0,
    Math.min(row.bottom, viewport.bottom) - Math.max(row.top, viewport.top),
  )
  return visible >= Math.min(row.height, viewport.height) * 0.6
}

export function useVisibleReads(
  scroller: RefObject<HTMLDivElement>,
  messages: Message[],
  userId: string,
  chatId: string | undefined,
  through: string,
  onRead?: (sequence: string) => void,
  isSettled?: () => boolean,
) {
  const candidates = new Map(
    messages
      .filter((message) => message.senderId !== userId)
      .map((message) => [message.id, message]),
  )
  const current = useRef({ candidates, through, onRead, isSettled })
  current.current = { candidates, through, onRead, isSettled }
  const rescan = useRef<() => void>()
  const enabled = Boolean(onRead)
  useEffect(() => {
    const viewport = scroller.current
    if (!viewport || !chatId || !enabled) return
    let reportedThrough = '0'
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    const observed = new Set<HTMLElement>()
    const active = () =>
      document.visibilityState === 'visible' &&
      document.hasFocus() &&
      (current.current.isSettled?.() ?? true)
    const visible = (row: HTMLElement) =>
      viewport.contains(row) &&
      active() &&
      isReadVisible(row.getBoundingClientRect(), viewport.getBoundingClientRect())
    const candidate = (id: string) => {
      const message = current.current.candidates.get(id)
      return message &&
        BigInt(message.sequence) > BigInt(current.current.through) &&
        BigInt(message.sequence) > BigInt(reportedThrough)
        ? message
        : undefined
    }
    const scan = () => {
      const rows = [...viewport.querySelectorAll<HTMLElement>('[data-message-id]')]
      const present = new Set(rows)
      for (const row of observed)
        if (!present.has(row)) {
          observer?.unobserve(row)
          observed.delete(row)
        }
      const eligible = new Set<string>()
      for (const row of rows) {
        if (!observed.has(row)) {
          observed.add(row)
          observer?.observe(row)
        }
        const id = row.dataset.messageId!
        if (!candidate(id) || !visible(row)) continue
        eligible.add(id)
        if (timers.has(id)) continue
        timers.set(
          id,
          setTimeout(() => {
            timers.delete(id)
            const message = candidate(id)
            if (message && visible(row)) {
              reportedThrough = message.sequence
              current.current.onRead?.(message.sequence)
            }
          }, 700),
        )
      }
      for (const [id, timer] of timers)
        if (!eligible.has(id)) {
          clearTimeout(timer)
          timers.delete(id)
        }
    }
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(scan) : null
    observer?.observe(viewport)
    rescan.current = scan
    scan()
    viewport.addEventListener('scroll', scan, { passive: true })
    window.addEventListener('focus', scan)
    window.addEventListener('blur', scan)
    window.addEventListener('resize', scan)
    document.addEventListener('visibilitychange', scan)
    return () => {
      rescan.current = undefined
      for (const timer of timers.values()) clearTimeout(timer)
      observer?.disconnect()
      viewport.removeEventListener('scroll', scan)
      window.removeEventListener('focus', scan)
      window.removeEventListener('blur', scan)
      window.removeEventListener('resize', scan)
      document.removeEventListener('visibilitychange', scan)
    }
  }, [scroller, userId, chatId, enabled])
  useEffect(() => rescan.current?.(), [messages, through, onRead])
}
