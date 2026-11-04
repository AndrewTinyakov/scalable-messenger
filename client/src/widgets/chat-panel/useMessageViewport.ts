import { useLayoutEffect, useRef, useState } from 'react'
import type { Message } from '../../entities/message/model'
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
}: Options) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [highlight, setHighlight] = useState<string | null>(null)
  useVisibleReads(scrollRef, messages, userId, chatId, throughSequence ?? '0', onRead)
  useLayoutEffect(() => {
    const command = reveal
    if (!command) return
    const scroller = scrollRef.current
    const target = [...(scroller?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])].find(
      (element) => element.dataset.messageId === command.messageId,
    )
    if (!scroller || !target) return
    const rowBounds = target.getBoundingClientRect()
    const viewBounds = scroller.getBoundingClientRect()
    scroller.scrollTop +=
      rowBounds.top - viewBounds.top - (viewBounds.height - rowBounds.height) / 2
    atBottomRef.current = false
    onViewPositionChange(false)
    setHighlight(command.messageId)
    announce('Original message shown.')
    if (command.focus) target.focus({ preventScroll: true })
    const timer = window.setTimeout(() => setHighlight(null), 2400)
    return () => window.clearTimeout(timer)
  }, [reveal])
  const anchorRef = useRef<{ id: string; top: number } | null>(null)
  const atBottomRef = useRef(true)
  const previousViewRef = useRef<{ chatId?: string; jumpRevision: number }>({
    chatId: undefined,
    jumpRevision,
  })
  const autoPageRef = useRef<{ older?: string; newer?: string }>({})

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
  }

  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    const previous = previousViewRef.current
    const switched = previous.chatId !== chatId || previous.jumpRevision !== jumpRevision
    previousViewRef.current = { chatId: chatId, jumpRevision }
    if (switched) {
      anchorRef.current = null
      autoPageRef.current = {}
      scroller.scrollTop = scroller.scrollHeight
      atBottomRef.current = true
      onViewPositionChange(true)
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
  }, [chatId, messages, pendingCount, hasNewer, jumpRevision])

  function handleScroll() {
    const scroller = scrollRef.current
    if (!scroller) return
    const distanceToBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
    atBottomRef.current = distanceToBottom < 48
    onViewPositionChange(atBottomRef.current && !hasNewer)
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
