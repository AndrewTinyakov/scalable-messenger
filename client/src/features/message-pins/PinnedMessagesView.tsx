import { ArrowLeft, ArrowRight, Copy, PinOff } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { MessageItem } from '../../entities/message/MessageItem'
import { groupByDay } from '../../entities/message/messageDays'
import type { Message } from '../../entities/message/model'
import { formatDayLabel } from '../../shared/lib/time'
import { Dialog } from '../../shared/ui/Dialog'
import { Menu, MenuItem, type MenuPoint } from '../../shared/ui/Menu'
import type { MessagePins } from './useMessagePins'

interface Props {
  pins: MessagePins
  currentUserId: string
  group: boolean
  senderName(senderId: string): string
  onBack(): void
  onJump(messageId: string): void
}

export function PinnedMessagesView({
  pins,
  currentUserId,
  group,
  senderName,
  onBack,
  onJump,
}: Props) {
  const [menu, setMenu] = useState<{
    message: Message
    anchor: HTMLElement
    point?: MenuPoint
  } | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const ordered = [...pins.pins].reverse()
  const days = groupByDay(ordered.map(({ message }) => ({ key: message.id, message })))
  const total = pins.total
  const firstLoad = useRef(true)
  useEffect(() => {
    const list = listRef.current
    if (!list || !ordered.length || !firstLoad.current) return
    firstLoad.current = false
    list.scrollTop = list.scrollHeight
  }, [ordered.length])
  useEffect(() => {
    if (total === 0 && !pins.pins.length) onBack()
  }, [total, pins.pins.length, onBack])

  async function unpinAll() {
    setBusy(true)
    setError(null)
    try {
      await pins.unpinAll()
      setConfirm(false)
      onBack()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not unpin messages')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="pinned-view" aria-label="Pinned messages">
      <header className="chat-header pinned-view-header">
        <button className="icon-button" onClick={onBack} aria-label="Back to chat">
          <ArrowLeft size={22} />
        </button>
        <div className="chat-header-info">
          <h2>
            {total} pinned {total === 1 ? 'message' : 'messages'}
          </h2>
        </div>
      </header>
      <div
        className="chat-body pinned-view-body"
        ref={listRef}
        onScroll={(event) => {
          if (event.currentTarget.scrollTop < 120 && pins.hasOlder && !pins.loadingOlder)
            void pins.loadOlder()
        }}
      >
        <div className="chat-body-inner">
          {pins.loadingOlder && (
            <span className="history-spinner" role="status" aria-label="Loading" />
          )}
          {days.map((day) => (
            <section className="message-day" key={day.key}>
              <div className="message-day-label">
                <span>{formatDayLabel(day.timestamp)}</span>
              </div>
              {day.entries.map(({ entry: { message } }) => {
                const mine = message.senderId === currentUserId
                return (
                  <MessageItem
                    key={message.id}
                    message={message}
                    mine={mine}
                    sender={mine ? 'You' : senderName(message.senderId)}
                    forwardedFrom={
                      message.forwardedFromUserId
                        ? senderName(message.forwardedFromUserId)
                        : undefined
                    }
                    group={group}
                    connected
                    onRetry={() => {}}
                    onActions={(target, anchor, _keyboard, point) =>
                      setMenu({ message: target, anchor, point })
                    }
                    aside={
                      <button
                        className="pinned-jump"
                        onClick={() => onJump(message.id)}
                        aria-label="Go to message"
                        title="Go to message"
                      >
                        <ArrowRight size={18} />
                      </button>
                    }
                  />
                )
              })}
            </section>
          ))}
        </div>
      </div>
      <footer className="pinned-view-footer">
        <button className="pinned-unpin-all" onClick={() => setConfirm(true)} disabled={!total}>
          Unpin all {total} {total === 1 ? 'message' : 'messages'}
        </button>
      </footer>
      {menu && (
        <Menu
          label="Pinned message actions"
          anchor={menu.anchor}
          point={menu.point}
          onClose={() => setMenu(null)}
        >
          <MenuItem
            icon={<ArrowRight size={18} />}
            onClick={() => {
              setMenu(null)
              onJump(menu.message.id)
            }}
          >
            Go to message
          </MenuItem>
          <MenuItem
            icon={<Copy size={18} />}
            onClick={() => {
              void navigator.clipboard?.writeText(menu.message.body).catch(() => {})
              setMenu(null)
            }}
          >
            Copy text
          </MenuItem>
          <MenuItem
            icon={<PinOff size={18} />}
            onClick={() => {
              const target = menu.message
              setMenu(null)
              void pins.unpin(target).catch(() => {})
            }}
          >
            Unpin
          </MenuItem>
        </Menu>
      )}
      {confirm && (
        <Dialog title="Unpin all messages?" onClose={() => setConfirm(false)} busy={busy}>
          <p className="dialog-description">
            Remove all {total} pinned {total === 1 ? 'message' : 'messages'} from the top of this
            chat.
          </p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button
              className="button button-ghost"
              disabled={busy}
              onClick={() => setConfirm(false)}
            >
              Cancel
            </button>
            <button
              className="button button-danger-ghost"
              disabled={busy}
              onClick={() => void unpinAll()}
            >
              {busy ? 'Unpinning…' : 'Unpin all'}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  )
}
