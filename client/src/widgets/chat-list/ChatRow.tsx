import { BellOff, Check, CircleAlert, Clock3, Pin } from 'lucide-react'
import { memo, useRef, type DragEvent } from 'react'
import { chatPeer, chatTitle, formatUnread, isMuted, type Chat } from '../../entities/chat/model'
import type { Message, PendingSend } from '../../entities/message/model'
import { ChatKind } from '../../shared/api/generated/socket-vocabulary'
import { formatChatTime } from '../../shared/lib/time'
import { Avatar } from '../../shared/ui/Avatar'
import type { MenuPoint } from '../../shared/ui/Menu'

const LONG_PRESS_MS = 480

export type OpenChatMenu = (
  chat: Chat,
  anchor: HTMLElement,
  keyboard: boolean,
  point?: MenuPoint,
) => void

interface Props {
  chat: Chat
  userId: string
  selected: boolean
  live?: boolean
  online: boolean
  loaded?: Message
  pending?: PendingSend
  dragging?: boolean
  onSelect(id: string): void
  onMenu: OpenChatMenu
  onDragStart?: (event: DragEvent<HTMLButtonElement>, chatId: string) => void
  onDragOver?: (event: DragEvent<HTMLButtonElement>, chatId: string) => void
  onDrop?: (event: DragEvent<HTMLButtonElement>, chatId: string) => void
  onDragEnd?: () => void
}

type PreviewState = PendingSend['status'] | undefined

function latestVisible(chat: Chat, loaded: Message | undefined) {
  const last = chat.lastMessage
  const usable = loaded && !loaded.deletedAt ? loaded : undefined
  if (usable && BigInt(usable.sequence) > BigInt(chat.lastSequence))
    return {
      senderId: usable.senderId,
      body: usable.body,
      senderUsername: undefined as string | undefined,
      createdAt: usable.createdAt,
    }
  if (last)
    return {
      senderId: last.senderId,
      body: last.bodyPreview,
      senderUsername: last.senderUsername,
      createdAt: last.createdAt,
    }
  return undefined
}

function preview(chat: Chat, userId: string, loaded: Message | undefined, pending?: PendingSend) {
  const visible = latestVisible(chat, loaded)
  const queued =
    pending &&
    pending.status !== 'saved' &&
    (!visible || Date.parse(pending.createdAt) >= Date.parse(visible.createdAt))
      ? pending
      : undefined
  const senderId = queued ? userId : visible?.senderId
  const body = queued ? queued.body : visible?.body
  const createdAt = queued?.createdAt ?? visible?.createdAt
  const state: PreviewState = queued?.status ?? (senderId === userId ? 'saved' : undefined)
  if (senderId === undefined)
    return {
      sender: '',
      text: chat.lastSequence === '0' ? 'No messages yet' : '',
      createdAt,
      state: undefined,
    }
  const mine = senderId === userId
  const sender = mine
    ? 'You'
    : chat.kind === ChatKind.GROUP
      ? (visible?.senderUsername ?? chat.members.find((member) => member.id === senderId)?.username)
      : undefined
  return { sender: sender ?? '', text: (body ?? '').replace(/\s+/g, ' '), createdAt, state }
}

function PreviewStateIcon({ state }: { state: PreviewState }) {
  if (state === 'rejected' || state === 'retryable')
    return <CircleAlert className="chat-item-state failed" size={14} aria-label="Not sent" />
  if (state === 'saved') return <Check className="chat-item-state" size={15} aria-label="Sent" />
  if (state) return <Clock3 className="chat-item-state" size={13} aria-label="Sending" />
  return null
}

export const ChatRow = memo(function ChatRow({
  chat,
  userId,
  selected,
  live = false,
  online,
  loaded,
  pending,
  dragging = false,
  onSelect,
  onMenu,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: Props) {
  const press = useRef<ReturnType<typeof setTimeout>>()
  const pressed = useRef(false)
  const title = chatTitle(chat, userId)
  const unread = live ? 0 : (chat.unreadCount ?? 0)
  const marked = !live && unread === 0 && Boolean(chat.markedUnread)
  const muted = isMuted(chat)
  const pinned = chat.pinnedRank != null
  const { sender, text, createdAt, state } = preview(chat, userId, loaded, pending)
  const release = () => clearTimeout(press.current)
  return (
    <button
      className={`chat-item ${selected ? 'selected' : ''} ${dragging ? 'dragging' : ''}`}
      data-chat-id={chat.id}
      data-pinned={pinned || undefined}
      draggable={pinned && Boolean(onDragStart)}
      onDragStart={pinned && onDragStart ? (event) => onDragStart(event, chat.id) : undefined}
      onDragOver={pinned && onDragOver ? (event) => onDragOver(event, chat.id) : undefined}
      onDrop={pinned && onDrop ? (event) => onDrop(event, chat.id) : undefined}
      onDragEnd={pinned ? onDragEnd : undefined}
      aria-current={selected ? 'true' : undefined}
      aria-haspopup="menu"
      onClick={() => {
        if (pressed.current) pressed.current = false
        else onSelect(chat.id)
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        onMenu(chat, event.currentTarget, event.detail === 0, {
          x: event.clientX,
          y: event.clientY,
        })
      }}
      onKeyDown={(event) => {
        if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
          event.preventDefault()
          onMenu(chat, event.currentTarget, true)
        }
      }}
      onTouchStart={(event) => {
        const target = event.currentTarget
        const touch = event.touches[0]
        pressed.current = false
        press.current = setTimeout(() => {
          pressed.current = true
          onMenu(chat, target, false, { x: touch.clientX, y: touch.clientY })
        }, LONG_PRESS_MS)
      }}
      onTouchMove={release}
      onTouchEnd={release}
      onTouchCancel={release}
    >
      <Avatar
        seed={chatPeer(chat, userId) ?? chat.id}
        name={title}
        size={54}
        group={chat.kind === ChatKind.GROUP}
        online={online}
      />
      <span className="chat-item-copy">
        <span className="chat-item-top">
          <strong>{title}</strong>
          {muted && <BellOff className="chat-item-muted" size={14} aria-label="Muted" />}
          <PreviewStateIcon state={state} />
          <time>{formatChatTime(createdAt)}</time>
        </span>
        <span className="chat-item-bottom">
          <span className="chat-preview">
            {sender && <span className="chat-preview-sender">{sender}: </span>}
            {text}
          </span>
          {unread > 0 && (
            <span
              className={`unread-badge ${muted ? 'muted' : ''}`}
              aria-label={`${unread} unread messages`}
            >
              {formatUnread(unread, chat.unreadCountCapped)}
            </span>
          )}
          {marked && (
            <span
              className={`unread-badge unread-mark ${muted ? 'muted' : ''}`}
              aria-label="Marked as unread"
            />
          )}
          {pinned && unread === 0 && !marked && (
            <Pin className="chat-item-pin" size={15} aria-label="Pinned" />
          )}
        </span>
      </span>
    </button>
  )
})
