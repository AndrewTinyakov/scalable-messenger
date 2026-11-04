import { useLayoutEffect, useRef, useState } from 'react'
import type { Message } from '../../entities/message/model'
import type { ReadingLocation } from '../../entities/message/readingLocation'
import { useVisibleReads } from '../../features/conversation/useVisibleReads'

interface Options {
  chatId?: string
  userId: string
  messages: Message[]
  pendingCount: number
  throughSequence?: string
  onRead?: (sequence: string) => void
  reveal?: { messageId: string; revision: number; focus: boolean } | null
  jumpRevision: number
  hasOlder: boolean
  hasNewer: boolean
  loadingOlder: boolean
  loadingNewer: boolean
  onLoadOlder(): void
  onLoadNewer(): void
  onViewPositionChange(atLatest: boolean): void
  announce(message: string): void
  readingLocation?: ReadingLocation
  locationRevision?: number
  onLocationChange?: (chatId: string, location: ReadingLocation) => void
}
export function useMessageViewport({
  chatId,
  userId,
  messages,
  pendingCount,
  throughSequence,
  onRead,
  reveal,
  jumpRevision,
  hasOlder,
  hasNewer,
  loadingOlder,
  loadingNewer,
  onLoadOlder,
  onLoadNewer,
  onViewPositionChange,
  announce,
  readingLocation,
  locationRevision = 0,
  onLocationChange,
}: Options) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [highlight, setHighlight] = useState<string | null>(null)
  const anchorRef = useRef<{ id: string; top: number } | null>(null)
  const restoredAnchor = useRef<{ id: string; offset: number } | null>(null)
  const atBottomRef = useRef(true)
  const previousViewRef = useRef<{
    chatId?: string
    jumpRevision: number
    locationRevision: number
  }>({ chatId: undefined, jumpRevision, locationRevision })
  const pendingRestore = useRef<ReadingLocation | null>(null)
  const autoPageRef = useRef<{ older?: string; newer?: string }>({})
  const captured = useRef<{ chatId: string; location: ReadingLocation } | null>(null)
  const options = useRef({ chatId, hasNewer, onLocationChange })
  options.current = { chatId, hasNewer, onLocationChange }

  function captureLocation() {
    const scroller = scrollRef.current
    const current = options.current
    if (!scroller || !current.chatId || pendingRestore.current) return
    const bounds = scroller.getBoundingClientRect()
    const target = [...scroller.querySelectorAll<HTMLElement>('[data-message-id]')].find((row) => {
      const rect = row.getBoundingClientRect()
      return rect.bottom > bounds.top && rect.top < bounds.bottom
    })
    if (!target?.dataset.messageId || !target.dataset.messageSequence) return
    const location: ReadingLocation = {
      messageId: target.dataset.messageId,
      sequence: target.dataset.messageSequence,
      offsetPx: target.getBoundingClientRect().top - bounds.top,
      atLatest: atBottomRef.current && !current.hasNewer,
    }
    captured.current = { chatId: current.chatId, location }
    current.onLocationChange?.(current.chatId, location)
  }

  useLayoutEffect(
    () => () => {
      const last = captured.current
      if (last && last.chatId === chatId)
        options.current.onLocationChange?.(last.chatId, last.location)
    },
    [chatId],
  )

  function rememberAnchor(direction: 'older' | 'newer') {
    const scroller = scrollRef.current
    if (!scroller) return
    const bounds = scroller.getBoundingClientRect()
    const visible = [...scroller.querySelectorAll<HTMLElement>('[data-message-id]')].filter(
      (element) =>
        element.getBoundingClientRect().bottom > bounds.top &&
        element.getBoundingClientRect().top < bounds.bottom,
    )
    const target = direction === 'older' ? visible[0] : visible.at(-1)
    if (target?.dataset.messageId)
      anchorRef.current = { id: target.dataset.messageId, top: target.getBoundingClientRect().top }
    restoredAnchor.current = null
  }

  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    const previous = previousViewRef.current
    const switched = previous.chatId !== chatId
    const jumped = previous.jumpRevision !== jumpRevision
    const locationChanged = previous.locationRevision !== locationRevision
    previousViewRef.current = { chatId, jumpRevision, locationRevision }
    if (switched || jumped || locationChanged) {
      anchorRef.current = null
      restoredAnchor.current = null
      autoPageRef.current = {}
      pendingRestore.current = readingLocation && !jumped ? readingLocation : null
      if (!pendingRestore.current) {
        scroller.scrollTop = scroller.scrollHeight
        atBottomRef.current = true
        onViewPositionChange(true)
        captureLocation()
        return
      }
    }
    const location = pendingRestore.current
    if (location) {
      if (location.atLatest) {
        scroller.scrollTop = scroller.scrollHeight
        atBottomRef.current = true
      } else {
        const rows = [...scroller.querySelectorAll<HTMLElement>('[data-message-id]')]
        const target = rows.find((row) => row.dataset.messageId === location.messageId)
        if (!target) return
        scroller.scrollTop +=
          target.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top -
          location.offsetPx
        restoredAnchor.current = { id: target.dataset.messageId!, offset: location.offsetPx }
        atBottomRef.current = false
      }
      pendingRestore.current = null
      onViewPositionChange(atBottomRef.current && !hasNewer)
      captureLocation()
      return
    }
    const anchor = anchorRef.current
    anchorRef.current = null
    const target =
      anchor &&
      [...scroller.querySelectorAll<HTMLElement>('[data-message-id]')].find(
        (element) => element.dataset.messageId === anchor.id,
      )
    if (anchor && target) scroller.scrollTop += target.getBoundingClientRect().top - anchor.top
    else if (atBottomRef.current && !hasNewer) scroller.scrollTop = scroller.scrollHeight
    captureLocation()
  }, [chatId, messages, pendingCount, hasNewer, jumpRevision, locationRevision])

  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    const intentional = () => {
      restoredAnchor.current = null
      pendingRestore.current = null
    }
    const keyboard = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key))
        intentional()
    }
    const resize =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            const anchor = restoredAnchor.current
            if (!anchor) return
            const target = [...scroller.querySelectorAll<HTMLElement>('[data-message-id]')].find(
              (row) => row.dataset.messageId === anchor.id,
            )
            if (target) {
              const delta =
                target.getBoundingClientRect().top -
                scroller.getBoundingClientRect().top -
                anchor.offset
              if (Math.abs(delta) > 0.5) scroller.scrollTop += delta
              captureLocation()
            }
          })
        : null
    if (scroller.firstElementChild) resize?.observe(scroller.firstElementChild)
    scroller.addEventListener('wheel', intentional, { passive: true })
    scroller.addEventListener('touchstart', intentional, { passive: true })
    scroller.addEventListener('pointerdown', intentional)
    scroller.addEventListener('keydown', keyboard)
    return () => {
      resize?.disconnect()
      scroller.removeEventListener('wheel', intentional)
      scroller.removeEventListener('touchstart', intentional)
      scroller.removeEventListener('pointerdown', intentional)
      scroller.removeEventListener('keydown', keyboard)
    }
  }, [chatId])

  useLayoutEffect(() => {
    const command = reveal
    if (!command) return
    const scroller = scrollRef.current
    const target = [...(scroller?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])].find(
      (element) => element.dataset.messageId === command.messageId,
    )
    if (!scroller || !target) return
    pendingRestore.current = null
    restoredAnchor.current = null
    const rowBounds = target.getBoundingClientRect()
    const viewBounds = scroller.getBoundingClientRect()
    scroller.scrollTop +=
      rowBounds.top - viewBounds.top - (viewBounds.height - rowBounds.height) / 2
    atBottomRef.current = false
    onViewPositionChange(false)
    setHighlight(command.messageId)
    captureLocation()
    announce('Original message shown.')
    if (command.focus) target.focus({ preventScroll: true })
    const timer = window.setTimeout(() => setHighlight(null), 2400)
    return () => window.clearTimeout(timer)
  }, [reveal])

  useVisibleReads(
    scrollRef,
    messages,
    userId,
    chatId,
    throughSequence ?? '0',
    onRead,
    () => !pendingRestore.current,
  )

  function handleScroll() {
    const scroller = scrollRef.current
    if (!scroller || pendingRestore.current) return
    const distanceToBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
    atBottomRef.current = distanceToBottom < 48
    onViewPositionChange(atBottomRef.current && !hasNewer)
    captureLocation()
    const first = messages[0]?.sequence
    const last = messages.at(-1)?.sequence
    if (
      scroller.scrollTop < 120 &&
      hasOlder &&
      !loadingOlder &&
      first &&
      autoPageRef.current.older !== first
    ) {
      autoPageRef.current.older = first
      rememberAnchor('older')
      onLoadOlder()
    } else if (
      distanceToBottom < 120 &&
      hasNewer &&
      !loadingNewer &&
      last &&
      autoPageRef.current.newer !== last
    ) {
      autoPageRef.current.newer = last
      rememberAnchor('newer')
      onLoadNewer()
    }
  }

  return { scrollRef, highlight, rememberAnchor, handleScroll }
}
