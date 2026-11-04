import {
  Check,
  CheckCheck,
  CircleAlert,
  Clock3,
  CornerUpLeft,
  MoreHorizontal,
  Pencil,
  Trash2,
} from 'lucide-react'
import { useRef, useState } from 'react'
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
  onReaders?: (message: Message) => void
  onReply?: (message: Message) => void
  onEdit?: (message: Message) => void
  onDelete?: (message: Message) => void
  onQuote?: (messageId: string, keyboard: boolean) => void
  quoteSender?: string
  quoteLoading?: boolean
  highlighted?: boolean
}

function SendStateIcon({ state }: { state: PendingSend['status'] }) {
  if (state === 'rejected' || state === 'retryable') return <CircleAlert size={13} />
  if (state === 'saved') return <Check size={13} />
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
  onReaders,
  onReply,
  onEdit,
  onDelete,
  onQuote,
  quoteSender,
  quoteLoading,
  highlighted,
}: Props) {
  const [menu, setMenu] = useState(false)
  const actionsRef = useRef<HTMLButtonElement>(null)
  const state = send?.status || (mine ? 'saved' : undefined)
  const timestamp = useRef(send?.createdAt ?? message?.createdAt ?? '')
  const statusLabel =
    state === 'saved'
      ? 'Sent'
      : state === 'rejected' || state === 'retryable'
        ? 'Not sent'
        : 'Pending'
  const deleted = Boolean(message?.deletedAt)
  return (
    <div
      className={`message-row ${mine ? 'mine' : ''} ${highlighted ? 'message-revealed' : ''}`}
      data-message-id={message?.id}
      tabIndex={-1}
    >
      {!mine && <span className="message-avatar">{sender[0]?.toUpperCase()}</span>}
      <div className="message-stack">
        {group && !mine && <span className="message-sender">{sender}</span>}
        <div
          className={`message-bubble ${deleted ? 'message-deleted' : ''} ${send?.status === 'rejected' || send?.status === 'retryable' ? 'rejected' : ''}`}
        >
          {message?.replyToMessageId && !deleted && (
            <button
              className="message-quote"
              disabled={quoteLoading}
              onClick={(event) => onQuote?.(message.replyToMessageId!, event.detail === 0)}
              aria-label={`Show original message from ${quoteSender ?? 'Member'}`}
            >
              <strong>
                <CornerUpLeft size={12} />
                {quoteLoading ? 'Finding original…' : (quoteSender ?? 'Member')}
              </strong>
              <span>{message.replyDeleted ? 'Message deleted' : message.replyBody}</span>
            </button>
          )}
          <span>{message ? (deleted ? 'Message deleted' : message.body) : send?.body}</span>
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
              <SendStateIcon state={state} />
            </span>
          )}
          {mine && message && !deleted && (
            <button
              className={`read-receipt ${read ? 'is-read' : ''}`}
              onClick={() => onReaders?.(message)}
              aria-label={read ? 'Read, view details' : 'View read details'}
            >
              {read && <CheckCheck size={14} />}
              <span>{read ? 'Read' : 'Read details'}</span>
            </button>
          )}
        </div>
        {message && !deleted && (onReply || onEdit || onDelete) && (
          <div
            className="message-actions"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation()
                setMenu(false)
                actionsRef.current?.focus()
              }
            }}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setMenu(false)
            }}
          >
            <button
              ref={actionsRef}
              className="message-action-trigger"
              aria-label={`Actions for ${mine ? 'your message' : `message from ${sender}`}`}
              aria-expanded={menu}
              onClick={() => setMenu(!menu)}
            >
              <MoreHorizontal size={17} />
            </button>
            {menu && (
              <div className="message-action-menu">
                {onReply && (
                  <button
                    onClick={() => {
                      setMenu(false)
                      onReply(message)
                    }}
                  >
                    <CornerUpLeft size={14} />
                    Reply
                  </button>
                )}
                {mine && onEdit && (
                  <button
                    onClick={() => {
                      setMenu(false)
                      onEdit(message)
                    }}
                  >
                    <Pencil size={14} />
                    Edit
                  </button>
                )}
                {mine && onDelete && (
                  <button
                    className="danger-text"
                    onClick={() => {
                      setMenu(false)
                      actionsRef.current?.focus()
                      onDelete(message)
                    }}
                  >
                    <Trash2 size={14} />
                    Delete
                  </button>
                )}
              </div>
            )}
          </div>
        )}
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
