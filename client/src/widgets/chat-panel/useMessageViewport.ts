import { useLayoutEffect, useRef, useState } from 'react'
import type { Message } from '../../entities/message/model'
import { subscribePagingFailures } from '../../entities/message/pagingFailures'
import type { ReadingLocation } from '../../entities/message/readingLocation'
import { useVisibleReads } from '../../features/conversation/useVisibleReads'

interface Options {
  chatId?: string
  userId: string
  messages: Message[]
  pendingState: string
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
type ViewRestoration =
  | { phase: 'settled' }
  | { phase: 'pending'; location: ReadingLocation }
  | { phase: 'anchored'; id: string; offset: number }

const BOTTOM_THRESHOLD = 48

function distanceToBottom(scroller: HTMLElement): number {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
}

export function useMessageViewport({
  chatId,
  userId,
  messages,
  pendingState,
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
  const restoration = useRef<ViewRestoration>({ phase: 'settled' })
  const atBottomRef = useRef(true)
  const scrollInputUntil = useRef(0)
  const lastScrollTop = useRef(0)
  const previousViewRef = useRef<{
    chatId?: string
    jumpRevision: number
    locationRevision: number
  }>({ chatId: undefined, jumpRevision, locationRevision })
  const autoPageRef = useRef<
    Partial<Record<'older' | 'newer', { anchor: string; at: number; attempts: number }>>
  >({})
  const historyKey = messages
    .map(
      (message) =>
        `${message.id}:${message.sequence}:${message.messageVersion ?? '1'}:${message.deletedAt ?? ''}`,
    )
    .join('|')
  const previousHistoryKey = useRef(historyKey)
  const pageFinishedAt = useRef(0)
  const wasPaging = useRef(false)
  useLayoutEffect(() => {
    const paging = loadingOlder || loadingNewer
    if (wasPaging.current && !paging) pageFinishedAt.current = Date.now()
    wasPaging.current = paging
  }, [loadingOlder, loadingNewer])
  const failedUntil = useRef<Partial<Record<'older' | 'newer', number>>>({})
  const pageTimer = useRef<ReturnType<typeof setTimeout>>()
  const pageRef = useRef<() => void>(() => {})
  useLayoutEffect(() => {
    if (previousHistoryKey.current !== historyKey) {
      failedUntil.current = {}
      previousHistoryKey.current = historyKey
    }
  }, [historyKey])
  const captured = useRef<{ chatId: string; location: ReadingLocation } | null>(null)
  const options = useRef({ chatId, hasNewer, onLocationChange })
  options.current = { chatId, hasNewer, onLocationChange }

  function pinToBottom(scroller: HTMLElement) {
    scroller.scrollTop = scroller.scrollHeight
    lastScrollTop.current = scroller.scrollTop
  }

  function captureLocation() {
    const scroller = scrollRef.current
    const current = options.current
    if (!scroller || !current.chatId || restoration.current.phase === 'pending') return
    lastScrollTop.current = scroller.scrollTop
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
    restoration.current = { phase: 'settled' }
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
      scrollInputUntil.current = 0
      anchorRef.current = null
      restoration.current = { phase: 'settled' }
      autoPageRef.current = {}
      failedUntil.current = {}
      restoration.current =
        readingLocation && !jumped
          ? { phase: 'pending', location: readingLocation }
          : { phase: 'settled' }
      if (restoration.current.phase !== 'pending') {
        pinToBottom(scroller)
        atBottomRef.current = true
        onViewPositionChange(!hasNewer)
        captureLocation()
        return
      }
    }
    const location = restoration.current.phase === 'pending' ? restoration.current.location : null
    if (location) {
      if (location.atLatest) {
        pinToBottom(scroller)
        atBottomRef.current = true
        restoration.current = { phase: 'settled' }
      } else {
        const rows = [...scroller.querySelectorAll<HTMLElement>('[data-message-id]')]
        const target = rows.find((row) => row.dataset.messageId === location.messageId)
        if (!target) return
        scroller.scrollTop +=
          target.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top -
          location.offsetPx
        restoration.current = {
          phase: 'anchored',
          id: target.dataset.messageId!,
          offset: location.offsetPx,
        }
        atBottomRef.current = false
      }
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
    else if (atBottomRef.current && !hasNewer) pinToBottom(scroller)
    atBottomRef.current = distanceToBottom(scroller) < BOTTOM_THRESHOLD
    onViewPositionChange(atBottomRef.current && !hasNewer)
    captureLocation()
  }, [chatId, messages, pendingState, hasNewer, jumpRevision, locationRevision])

  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    const intentional = () => {
      scrollInputUntil.current = Date.now() + 1500
      restoration.current = { phase: 'settled' }
      scroller.dispatchEvent(new Event('reading-settled'))
    }
    const dragging = (event: PointerEvent) => {
      if (event.buttons) scrollInputUntil.current = Date.now() + 1500
    }
    const focused = () => {
      scrollInputUntil.current = Date.now() + 1500
    }
    const keyboard = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key))
        intentional()
    }
    const resize =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            if (
              atBottomRef.current &&
              !options.current.hasNewer &&
              restoration.current.phase !== 'pending'
            ) {
              pinToBottom(scroller)
              return
            }
            const anchor = restoration.current.phase === 'anchored' ? restoration.current : null
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
    scroller.addEventListener('touchmove', intentional, { passive: true })
    scroller.addEventListener('pointerdown', intentional)
    scroller.addEventListener('pointermove', dragging)
    scroller.addEventListener('keydown', keyboard)
    scroller.addEventListener('focusin', focused)
    return () => {
      resize?.disconnect()
      scroller.removeEventListener('wheel', intentional)
      scroller.removeEventListener('touchstart', intentional)
      scroller.removeEventListener('touchmove', intentional)
      scroller.removeEventListener('pointerdown', intentional)
      scroller.removeEventListener('pointermove', dragging)
      scroller.removeEventListener('keydown', keyboard)
      scroller.removeEventListener('focusin', focused)
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
    restoration.current = { phase: 'settled' }
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
    () => restoration.current.phase !== 'pending',
  )

  function stickToLatest() {
    const scroller = scrollRef.current
    if (!scroller) return
    restoration.current = { phase: 'settled' }
    anchorRef.current = null
    atBottomRef.current = true
    pinToBottom(scroller)
  }

  function handleScroll() {
    const scroller = scrollRef.current
    if (!scroller || restoration.current.phase === 'pending') return
    const atBottom = distanceToBottom(scroller) < BOTTOM_THRESHOLD
    const userMoved =
      Date.now() <= scrollInputUntil.current &&
      (!atBottomRef.current || atBottom || scroller.scrollTop < lastScrollTop.current)
    if (userMoved) atBottomRef.current = atBottom
    else if (atBottomRef.current && !hasNewer) pinToBottom(scroller)
    lastScrollTop.current = scroller.scrollTop
    onViewPositionChange(atBottomRef.current && !hasNewer)
    captureLocation()
    autoPage()
  }

  function autoPage() {
    clearTimeout(pageTimer.current)
    const scroller = scrollRef.current
    if (
      !scroller ||
      restoration.current.phase === 'pending' ||
      document.visibilityState !== 'visible'
    )
      return
    if (loadingOlder || loadingNewer) return
    const direction =
      hasNewer && distanceToBottom(scroller) < 120
        ? 'newer'
        : hasOlder && scroller.scrollTop < 120
          ? 'older'
          : null
    if (!direction) return
    const anchor =
      (direction === 'older' ? messages[0]?.sequence : messages.at(-1)?.sequence) ?? '0'
    const previous = autoPageRef.current[direction]
    const lastPageAt = Math.max(
      pageFinishedAt.current,
      autoPageRef.current.older?.at ?? 0,
      autoPageRef.current.newer?.at ?? 0,
    )
    const attempts = previous?.anchor === anchor ? previous.attempts : 0
    const retryAt = Math.max(
      failedUntil.current[direction] ?? 0,
      lastPageAt + 300,
      (previous?.at ?? 0) + (attempts ? Math.min(30000, 1000 * 2 ** (attempts - 1)) : 0),
    )
    if (!Number.isFinite(retryAt)) return
    if (Date.now() < retryAt) {
      clearTimeout(pageTimer.current)
      pageTimer.current = setTimeout(() => pageRef.current(), retryAt - Date.now())
      return
    }
    autoPageRef.current[direction] = { anchor, at: Date.now(), attempts: attempts + 1 }
    rememberAnchor(direction)
    if (direction === 'older') onLoadOlder()
    else onLoadNewer()
    clearTimeout(pageTimer.current)
    pageTimer.current = setTimeout(() => pageRef.current(), Math.min(30000, 1000 * 2 ** attempts))
  }

  useLayoutEffect(
    () =>
      subscribePagingFailures((failure) => {
        if (failure.chatId !== chatId) return
        clearTimeout(pageTimer.current)
        if (failure.direction) failedUntil.current[failure.direction] = failure.until
        else failedUntil.current = {}
        if (Number.isFinite(failure.until))
          pageTimer.current = setTimeout(
            () => pageRef.current(),
            Math.max(0, failure.until - Date.now()),
          )
      }),
    [chatId],
  )

  pageRef.current = autoPage
  useLayoutEffect(() => {
    clearTimeout(pageTimer.current)
    pageRef.current()
    return () => clearTimeout(pageTimer.current)
  }, [
    chatId,
    messages,
    pendingState,
    hasOlder,
    hasNewer,
    loadingOlder,
    loadingNewer,
    jumpRevision,
    locationRevision,
  ])

  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    const evaluate = () => pageRef.current()
    const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(evaluate) : null
    resize?.observe(scroller)
    if (scroller.firstElementChild) resize?.observe(scroller.firstElementChild)
    document.addEventListener('visibilitychange', evaluate)
    return () => {
      resize?.disconnect()
      document.removeEventListener('visibilitychange', evaluate)
    }
  }, [chatId])

  return { scrollRef, highlight, handleScroll, stickToLatest }
}
