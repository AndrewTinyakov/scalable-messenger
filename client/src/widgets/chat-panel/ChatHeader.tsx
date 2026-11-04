import { ArrowLeft, Eraser, MoreHorizontal, Trash2, UsersRound } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { chatInitials, chatTitle, type Chat } from '../../entities/chat/model'
import type { User } from '../../entities/session/model'
import { ChatKind } from '../../shared/api/generated/socket-vocabulary'
import type { PresenceStatus } from '../../shared/api/socket'
import type { ConnectionState } from '../../shared/api/socketConnection'

interface Props {
  chat: Chat
  currentUser: User
  connection: ConnectionState
  presence?: Record<string, PresenceStatus['state']>
  onBack(): void
  onMembers?: () => void
  onDelete?: () => void
  onClear?: () => void
}
export function ChatHeader({
  chat,
  currentUser,
  connection,
  presence,
  onBack,
  onMembers,
  onDelete,
  onClear,
}: Props) {
  const [chatMenu, setChatMenu] = useState(false)
  const actionsRef = useRef<HTMLButtonElement>(null)
  const recipient =
    chat.kind === ChatKind.DIRECT
      ? chat.members.find((member) => member.id !== currentUser.id)?.id
      : undefined
  useEffect(() => setChatMenu(false), [chat.id])
  return (
    <header className="chat-header">
      <button className="icon-button mobile-back" onClick={onBack} aria-label="Back to chats">
        <ArrowLeft size={20} />
      </button>
      <span className={`chat-header-avatar ${chat.kind === ChatKind.GROUP ? 'group-avatar' : ''}`}>
        {chat.kind === ChatKind.GROUP ? (
          <UsersRound size={22} />
        ) : (
          chatInitials(chat, currentUser.id)
        )}
        {recipient && presence && (
          <span
            className={`presence-dot ${presence[recipient] ?? 'unknown'}`}
            aria-label={`Presence ${presence[recipient] ?? 'unknown'}`}
          />
        )}
      </span>
      <div className="chat-header-info">
        <h2>{chatTitle(chat, currentUser.id)}</h2>
        <p>
          {chat.kind === ChatKind.GROUP
            ? `${chat.memberCount} members${presence ? (Object.keys(presence).length ? ` · ${Object.values(presence).filter((state) => state === 'online').length} online here` : ' · Presence unknown') : ''}`
            : presence && recipient
              ? presence[recipient] === 'online'
                ? 'Online'
                : presence[recipient] === 'offline'
                  ? 'Offline'
                  : 'Presence unknown'
              : 'Direct chat'}
        </p>
      </div>
      {chat.kind === ChatKind.GROUP && onMembers && (
        <button className="group-members-button" onClick={onMembers} aria-label="Group members">
          <UsersRound size={17} /> <span>Members</span>
        </button>
      )}
      {(onDelete || onClear) && !chat.id.startsWith('draft:') && (
        <div
          className="chat-overflow"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              setChatMenu(false)
              actionsRef.current?.focus()
            }
          }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setChatMenu(false)
          }}
        >
          <button
            className="icon-button"
            ref={actionsRef}
            aria-label="Chat actions"
            aria-expanded={chatMenu}
            onClick={() => setChatMenu(!chatMenu)}
          >
            <MoreHorizontal size={20} />
          </button>
          {chatMenu && (
            <div className="message-action-menu">
              {onClear && (
                <button
                  onClick={() => {
                    setChatMenu(false)
                    actionsRef.current?.focus()
                    onClear()
                  }}
                >
                  <Eraser size={14} />
                  Clear history
                </button>
              )}
              {onDelete && (
                <button
                  className="danger-text"
                  onClick={() => {
                    setChatMenu(false)
                    actionsRef.current?.focus()
                    onDelete()
                  }}
                >
                  <Trash2 size={14} />
                  Delete chat
                </button>
              )}
            </div>
          )}
        </div>
      )}
      <span className={`connection-pill ${connection}`}>
        <span />
        {connection === 'connected'
          ? 'Live'
          : connection === 'connecting'
            ? 'Connecting'
            : 'Offline'}
      </span>
    </header>
  )
}
