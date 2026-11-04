import { useEffect, useRef, useState, type RefObject } from 'react'
import type { Message } from '../../entities/message/model'

export const MAX_SELECTED_MESSAGES = 100

interface Gesture {
  pointerId: number
  startId: string
  startY: number
  y: number
  selecting: boolean
  initial: Map<string, Message>
  dragged: boolean
}

export function useMessageSelection(
  scroller: RefObject<HTMLDivElement>,
  messages: Message[],
  chatId?: string,
) {
  const [enabled, setEnabled] = useState(false)
  const [selected, setSelected] = useState(new Map<string, Message>())
  const current = useRef({ messages, selected, enabled })
  current.current = { messages, selected, enabled }
  const gesture = useRef<Gesture | null>(null)
  const suppressUntil = useRef(0)
  const frame = useRef<number>()
  const cancelRef = useRef<() => void>()

  function stop(restore: boolean) {
    const active = gesture.current
    gesture.current = null
    if (frame.current !== undefined) window.cancelAnimationFrame(frame.current)
    frame.current = undefined
    if (!active) return
    suppressUntil.current = Date.now() + 400
    if (restore) setSelected(new Map(active.initial))
    if (scroller.current?.hasPointerCapture?.(active.pointerId))
      scroller.current.releasePointerCapture(active.pointerId)
  }
  cancelRef.current = () => stop(true)

  useEffect(() => {
    setEnabled(false)
    setSelected(new Map())
    suppressUntil.current = 0
    return () => {
      gesture.current = null
      if (frame.current !== undefined) window.cancelAnimationFrame(frame.current)
    }
  }, [chatId])

  useEffect(() => {
    const cancel = () => cancelRef.current?.()
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancel()
    }
    window.addEventListener('blur', cancel)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('blur', cancel)
      window.removeEventListener('keydown', key)
    }
  }, [])

  function toggle(message: Message) {
    setSelected((previous) => {
      const next = new Map(previous)
      if (next.has(message.id)) next.delete(message.id)
      else if (next.size < MAX_SELECTED_MESSAGES) next.set(message.id, message)
      return next
    })
  }

  function applyRange() {
    const active = gesture.current
    const viewport = scroller.current
    if (!active || !viewport) return
    const rows = [...viewport.querySelectorAll<HTMLElement>('[data-message-id]')]
    const start = rows.findIndex((row) => row.dataset.messageId === active.startId)
    if (start < 0) return
    let end = rows.findIndex((row) => active.y < row.getBoundingClientRect().bottom)
    if (end < 0) end = rows.length - 1
    const byId = new Map(current.current.messages.map((message) => [message.id, message]))
    const next = new Map(active.initial)
    const direction = end >= start ? 1 : -1
    for (let index = start; ; index += direction) {
      const id = rows[index]?.dataset.messageId
      const message = id ? byId.get(id) : undefined
      if (message && !message.deletedAt) {
        if (!active.selecting) next.delete(message.id)
        else if (next.size < MAX_SELECTED_MESSAGES) next.set(message.id, message)
      }
      if (index === end) break
    }
    setSelected(next)
  }

  function autoScroll() {
    const active = gesture.current
    const viewport = scroller.current
    if (!active || !viewport) return
    const bounds = viewport.getBoundingClientRect()
    const edge = Math.min(48, bounds.height / 3)
    const velocity =
      active.y < bounds.top + edge
        ? -Math.min(18, (bounds.top + edge - active.y) / 3)
        : active.y > bounds.bottom - edge
          ? Math.min(18, (active.y - bounds.bottom + edge) / 3)
          : 0
    if (active.dragged && velocity) {
      viewport.scrollTop += velocity
      applyRange()
    }
    frame.current = window.requestAnimationFrame(autoScroll)
  }

  function targetMessage(target: EventTarget | null) {
    const element = target as HTMLElement | null
    if (element?.closest('button, a, input, textarea')) return
    const id = element?.closest<HTMLElement>('[data-message-id]')?.dataset.messageId
    return current.current.messages.find((message) => message.id === id && !message.deletedAt)
  }

  return {
    enabled,
    selected,
    start(message: Message) {
      setEnabled(true)
      setSelected(new Map([[message.id, message]]))
    },
    clear() {
      stop(false)
      setEnabled(false)
      setSelected(new Map())
    },
    handlers: {
      onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
        if (!enabled || event.button !== 0 || event.pointerType === 'touch') return
        const message = targetMessage(event.target)
        if (!message) return
        event.preventDefault()
        gesture.current = {
          pointerId: event.pointerId,
          startId: message.id,
          startY: event.clientY,
          y: event.clientY,
          selecting: !selected.has(message.id),
          initial: new Map(selected),
          dragged: false,
        }
        toggle(message)
        event.currentTarget.setPointerCapture?.(event.pointerId)
        frame.current = window.requestAnimationFrame(autoScroll)
      },
      onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
        const active = gesture.current
        if (!active || event.pointerId !== active.pointerId) return
        active.y = event.clientY
        if (Math.abs(active.y - active.startY) >= 5) active.dragged = true
        if (active.dragged) applyRange()
      },
      onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
        if (gesture.current?.pointerId === event.pointerId) stop(false)
      },
      onPointerCancel() {
        stop(true)
      },
      onLostPointerCapture() {
        stop(true)
      },
      onClickCapture(event: React.MouseEvent<HTMLDivElement>) {
        if (event.detail !== 0 && Date.now() < suppressUntil.current) {
          event.preventDefault()
          event.stopPropagation()
          return
        }
        if (!enabled) return
        const message = targetMessage(event.target)
        if (!message) return
        event.preventDefault()
        event.stopPropagation()
        toggle(message)
      },
      onKeyDownCapture(event: React.KeyboardEvent<HTMLDivElement>) {
        if (enabled && event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          if (gesture.current) stop(true)
          else {
            setEnabled(false)
            setSelected(new Map())
          }
          return
        }
        if (!enabled || !['Enter', ' '].includes(event.key)) return
        const message = targetMessage(event.target)
        if (!message) return
        event.preventDefault()
        event.stopPropagation()
        toggle(message)
      },
    },
  }
}
