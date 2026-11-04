import { CheckSquare, Copy, CornerUpLeft, Pencil, Trash2 } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Message } from '../../entities/message/model'
import type { ReaderPage } from '../../shared/api/featureDecode'
import { InlineReaders } from './InlineReaders'

interface Props {
  message: Message
  anchor: HTMLElement
  keyboard: boolean
  mine: boolean
  readers?: (chatId: string, messageId: string, afterUserId?: string) => Promise<ReaderPage>
  onReply(): void
  onEdit?: () => void
  onDelete(): void
  onSelect(): void
  onClose(): void
}

export function MessageActionMenu({
  message,
  anchor,
  keyboard,
  mine,
  readers,
  onReply,
  onEdit,
  onDelete,
  onSelect,
  onClose,
}: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const [copyError, setCopyError] = useState(false)
  const close = useRef(onClose)
  close.current = onClose
  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    const place = () => {
      const bounds = anchor.getBoundingClientRect()
      const size = menu.getBoundingClientRect()
      const top =
        bounds.bottom + 6 + size.height <= window.innerHeight - 12
          ? bounds.bottom + 6
          : Math.max(12, bounds.top - size.height - 6)
      const left = Math.max(
        12,
        Math.min(
          mine ? bounds.right - size.width : bounds.left,
          window.innerWidth - size.width - 12,
        ),
      )
      setPosition({ top, left })
    }
    place()
    const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null
    resize?.observe(menu)
    window.addEventListener('resize', place)
    if (keyboard) menu.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    return () => {
      resize?.disconnect()
      window.removeEventListener('resize', place)
    }
  }, [anchor, mine, keyboard])
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node) && !anchor.contains(event.target as Node))
        close.current()
    }
    const scroll = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) close.current()
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('scroll', scroll, true)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('scroll', scroll, true)
    }
  }, [anchor])
  function action(callback: () => void) {
    anchor.closest<HTMLElement>('[data-message-id]')?.focus({ preventScroll: true })
    onClose()
    callback()
  }
  return createPortal(
    <div
      ref={ref}
      className="message-action-menu message-popup"
      style={position}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          action(() => {})
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
        const index = items.indexOf(document.activeElement as HTMLElement)
        if (index < 0) return
        event.preventDefault()
        items[
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
        ]?.focus()
      }}
    >
      <div role="menu" aria-label="Message actions">
        <button role="menuitem" onClick={() => action(onReply)}>
          <CornerUpLeft size={15} />
          Reply
        </button>
        {onEdit && (
          <button role="menuitem" onClick={() => action(onEdit)}>
            <Pencil size={15} />
            Edit
          </button>
        )}
        <button
          role="menuitem"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(message.body)
              action(() => {})
            } catch {
              setCopyError(true)
            }
          }}
        >
          <Copy size={15} />
          Copy
        </button>
        <button role="menuitem" className="danger-text" onClick={() => action(onDelete)}>
          <Trash2 size={15} />
          Delete
        </button>
        <button role="menuitem" onClick={() => action(onSelect)}>
          <CheckSquare size={15} />
          Select
        </button>
      </div>
      {copyError && (
        <p className="popup-error" role="alert">
          Could not copy. Select the message text to copy it.
        </p>
      )}
      {mine && readers && <InlineReaders key={message.id} message={message} load={readers} />}
    </div>,
    document.body,
  )
}
