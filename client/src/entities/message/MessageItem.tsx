import { Check, CheckCheck, CircleAlert, Clock3, CornerUpLeft } from 'lucide-react'
import { useRef } from 'react'
import { formatMessageTime } from '../../shared/lib/time'
import type { Message, PendingSend } from './model'

interface Props {
  message?: Message
  send?: PendingSend
  mine: boolean
  sender: string
  group: boolean
  connected: boolean
  onRetry: (requestId: string) => void
  read?: boolean
  onActions?: (message: Message, anchor: HTMLElement, keyboard: boolean) => void
  onReply?: (message: Message) => void
  onQuote?: (messageId: string, keyboard: boolean) => void
  quoteSender?: string
  quoteLoading?: boolean
  highlighted?: boolean
  runStart?: boolean
  runEnd?: boolean
  selectionMode?: boolean
  selected?: boolean
}

function SendStateIcon({ state, read }: { state: PendingSend['status']; read?: boolean }) {
  if (state === 'rejected' || state === 'retryable') return <CircleAlert size={13} />
  if (state === 'saved') return read ? <CheckCheck size={15} /> : <Check size={13} />
  return <Clock3 size={13} />
}

export function MessageItem({
  message,
  send,
  mine,
  sender,
  group,
  connected,
  onRetry,
  read,
  onActions,
  onReply,
  onQuote,
  quoteSender,
  quoteLoading,
  highlighted,
  runStart = true,
  runEnd = true,
  selectionMode = false,
  selected = false,
}: Props) {
  const bubbleRef = useRef<HTMLDivElement>(null)
  const pointer = useRef({ x: 0, y: 0, moved: false })
  const state = send?.status || (mine ? 'saved' : undefined)
  const timestamp = useRef(send?.createdAt ?? message?.createdAt ?? '')
  const statusLabel =
    state === 'saved'
      ? read
        ? 'Read by another member'
        : 'Sent'
      : state === 'rejected' || state === 'retryable'
        ? 'Not sent'
        : 'Pending'
  const deleted = Boolean(message?.deletedAt)
  const unavailableQuote = Boolean(
    message?.replyToMessageId &&
    (message.replyDeleted || message.replySenderId == null || message.replyBody == null),
  )
  function openActions(keyboard: boolean) {
    if (message && !deleted && !selectionMode && bubbleRef.current)
      onActions?.(message, bubbleRef.current, keyboard)
  }
  return (
    <div
      className={`message-row ${mine ? 'mine' : ''} ${highlighted ? 'message-revealed' : ''} ${runStart ? 'run-start' : 'run-continued'} ${runEnd ? 'run-end' : ''} ${selected ? 'message-selected' : ''}`}
      data-message-id={message?.id}
      data-message-sequence={message?.sequence}
      tabIndex={message && !deleted ? 0 : -1}
      role={selectionMode && message && !deleted ? 'checkbox' : undefined}
      aria-checked={selectionMode && message && !deleted ? selected : undefined}
      aria-label={message && !deleted ? `Message from ${sender}` : undefined}
      aria-haspopup={!selectionMode && onActions && !deleted ? 'menu' : undefined}
      onPointerDown={(event) => {
        if (event.button === 0)
          pointer.current = { x: event.clientX, y: event.clientY, moved: false }
      }}
      onPointerMove={(event) => {
        if (
          event.buttons &&
          Math.hypot(event.clientX - pointer.current.x, event.clientY - pointer.current.y) > 5
        )
          pointer.current.moved = true
      }}
      onClick={(event) => {
        if (event.button !== 0 || (event.target as HTMLElement).closest('button, a')) return
        if (event.detail > 1 || pointer.current.moved) return
        openActions(false)
      }}
      onContextMenu={(event) => {
        if (!message || deleted) return
        event.preventDefault()
        openActions(false)
      }}
      onDoubleClick={(event) => {
        if (selectionMode || !message || deleted) return
        if (pointer.current.moved || (event.target as HTMLElement).closest('button, a')) return
        onReply?.(message)
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || selectionMode) return
        if (
          ['Enter', ' ', 'ContextMenu'].includes(event.key) ||
          (event.key === 'F10' && event.shiftKey)
        ) {
          event.preventDefault()
          openActions(true)
        }
      }}
    >
      {selectionMode && message && !deleted && (
        <span className="message-selection-mark" aria-hidden="true">
          {selected && <Check size={14} />}
        </span>
      )}
      {!mine && (
        <span className={`message-avatar ${runEnd ? '' : 'avatar-spacer'}`} aria-hidden="true">
          {sender[0]?.toUpperCase()}
        </span>
      )}
      <div className="message-stack">
        {group && !mine && runStart && <span className="message-sender">{sender}</span>}
        <div
          ref={bubbleRef}
          className={`message-bubble ${deleted ? 'message-deleted' : ''} ${send?.status === 'rejected' || send?.status === 'retryable' ? 'rejected' : ''}`}
        >
          {message?.replyToMessageId && !deleted && (
            <button
              className="message-quote"
              disabled={quoteLoading || unavailableQuote}
              onClick={(event) => onQuote?.(message.replyToMessageId!, event.detail === 0)}
              aria-label={`Show original message from ${quoteSender ?? 'Member'}`}
            >
              <strong>
                <CornerUpLeft size={12} />
                {quoteLoading ? 'Finding original…' : (quoteSender ?? 'Member')}
              </strong>
              <span>{unavailableQuote ? 'Original message unavailable' : message.replyBody}</span>
            </button>
          )}
          <span className="message-text">
            {message ? (deleted ? 'Message deleted' : message.body) : send?.body}
          </span>
        </div>
        <div className="message-meta">
          <time dateTime={timestamp.current} title={new Date(timestamp.current).toLocaleString()}>
            {formatMessageTime(timestamp.current)}
          </time>
          {message?.editedAt && !deleted && <span>edited</span>}
          {state && (
            <span
              className={`send-state ${state}`}
              role="img"
              aria-label={statusLabel}
              title={statusLabel}
            >
              <SendStateIcon state={state} read={read} />
            </span>
          )}
        </div>
        {send?.status === 'rejected' && (
          <div className="rejection-reason">
            {send.reason || 'This message could not be saved.'}
          </div>
        )}
        {send?.status === 'retryable' && (
          <div className="retry-wrap">
            <span>{send.reason}</span>
            <button
              className="retry-send"
              type="button"
              onClick={() => onRetry(send.requestId)}
              disabled={!connected}
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
