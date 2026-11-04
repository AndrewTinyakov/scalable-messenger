import { memo, useRef } from 'react'
import { chatPeer, chatTitle, formatUnread, type Chat } from '../../entities/chat/model'
import type { Message } from '../../entities/message/model'
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
  online: boolean
  loaded?: Message
  onSelect(id: string): void
  onMenu: OpenChatMenu
}

function preview(chat: Chat, userId: string, loaded: Message | undefined) {
  const last = chat.lastMessage
  const senderId = last?.senderId ?? loaded?.senderId
  const body = last?.body ?? loaded?.body
  const deleted = last ? last.deleted : Boolean(loaded?.deletedAt)
  const createdAt = last?.createdAt ?? loaded?.createdAt
  if (senderId === undefined)
    return { sender: '', text: chat.lastSequence === '0' ? 'No messages yet' : '', createdAt }
  const mine = senderId === userId
  const sender = mine
    ? 'You'
    : chat.kind === ChatKind.GROUP
      ? (last?.senderUsername ?? chat.members.find((member) => member.id === senderId)?.username)
      : undefined
  return {
    sender: sender ?? '',
    text: deleted ? 'Message deleted' : (body ?? '').replace(/\s+/g, ' '),
    createdAt,
  }
}

export const ChatRow = memo(function ChatRow({
  chat,
  userId,
  selected,
  online,
  loaded,
  onSelect,
  onMenu,
}: Props) {
  const press = useRef<ReturnType<typeof setTimeout>>()
  const pressed = useRef(false)
  const title = chatTitle(chat, userId)
  const unread = chat.unreadCount ?? 0
  const { sender, text, createdAt } = preview(chat, userId, loaded)
  const release = () => clearTimeout(press.current)
  return (
    <button
      className={`chat-item ${selected ? 'selected' : ''}`}
      data-chat-id={chat.id}
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
          <time>{formatChatTime(createdAt)}</time>
        </span>
        <span className="chat-item-bottom">
          <span className="chat-preview">
            {sender && <span className="chat-preview-sender">{sender}: </span>}
            {text}
          </span>
          {unread > 0 && (
            <span className="unread-badge" aria-label={`${unread} unread messages`}>
              {formatUnread(unread)}
            </span>
          )}
        </span>
      </span>
    </button>
  )
})
