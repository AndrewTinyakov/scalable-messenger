import { ArrowLeft, Bell, BellOff, Eraser, MoreVertical, Trash2, UsersRound } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { chatTitle, type Chat } from '../../entities/chat/model'
import type { User } from '../../entities/session/model'
import { ChatKind } from '../../shared/api/generated/socket-vocabulary'
import type { PresenceStatus } from '../../shared/api/socket'
import { Avatar } from '../../shared/ui/Avatar'
import { Menu, MenuItem } from '../../shared/ui/Menu'

interface Props {
  chat: Chat
  currentUser: User
  presence?: Record<string, PresenceStatus['state']>
  onBack(): void
  onMembers?: () => void
  onDelete?: () => void
  onClear?: () => void
  muted?: boolean
  onMute?: () => void
  onUnmute?: () => void
}

function subtitle(
  chat: Chat,
  recipient: string | undefined,
  presence: Props['presence'],
): { text: string; online: boolean } {
  if (chat.kind === ChatKind.GROUP) {
    const members = `${chat.memberCount} ${chat.memberCount === 1 ? 'member' : 'members'}`
    const online = Object.values(presence ?? {}).filter((state) => state === 'online').length
    return { text: online ? `${members}, ${online} online` : members, online: false }
  }
  const state = recipient ? presence?.[recipient] : undefined
  if (state === 'online') return { text: 'online', online: true }
  if (state === 'offline') return { text: 'offline', online: false }
  return { text: '', online: false }
}

export function ChatHeader({
  chat,
  currentUser,
  presence,
  onBack,
  onMembers,
  onDelete,
  onClear,
  muted = false,
  onMute,
  onUnmute,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false)
  const actionsRef = useRef<HTMLButtonElement>(null)
  const group = chat.kind === ChatKind.GROUP
  const recipient = group
    ? undefined
    : chat.members.find((member) => member.id !== currentUser.id)?.id
  const title = chatTitle(chat, currentUser.id)
  const status = subtitle(chat, recipient, presence)
  useEffect(() => setMenuOpen(false), [chat.id])

  function run(action: () => void) {
    setMenuOpen(false)
    actionsRef.current?.focus()
    action()
  }

  return (
    <header className="chat-header">
      <button className="icon-button mobile-back" onClick={onBack} aria-label="Back to chats">
        <ArrowLeft size={22} />
      </button>
      <Avatar
        seed={recipient ?? chat.id}
        name={title}
        size={42}
        group={group}
        online={status.online}
      />
      <div className="chat-header-info" key={recipient ?? chat.id}>
        <h2>
          {title}
          {muted && <BellOff className="chat-muted-icon" size={15} aria-label="Muted" />}
        </h2>
        <p key={status.text} className={status.online ? 'online' : undefined}>
          {status.text}
        </p>
      </div>
      {group && onMembers && (
        <button className="icon-button" onClick={onMembers} aria-label="Group members">
          <UsersRound size={21} />
        </button>
      )}
      {(onDelete || onClear) && !chat.id.startsWith('draft:') && (
        <button
          className="icon-button"
          ref={actionsRef}
          aria-label="Chat actions"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(!menuOpen)}
        >
          <MoreVertical size={21} />
        </button>
      )}
      {menuOpen && actionsRef.current && (
        <Menu
          label="Chat actions"
          anchor={actionsRef.current}
          align="end"
          onClose={() => {
            setMenuOpen(false)
            actionsRef.current?.focus()
          }}
        >
          {muted && onUnmute && (
            <MenuItem icon={<Bell size={18} />} onClick={() => run(onUnmute)}>
              Unmute
            </MenuItem>
          )}
          {!muted && onMute && (
            <MenuItem icon={<BellOff size={18} />} onClick={() => run(onMute)}>
              Mute notifications
            </MenuItem>
          )}
          {onClear && (
            <MenuItem icon={<Eraser size={18} />} onClick={() => run(onClear)}>
              Clear history
            </MenuItem>
          )}
          {onDelete && (
            <MenuItem icon={<Trash2 size={18} />} danger onClick={() => run(onDelete)}>
              Delete chat
            </MenuItem>
          )}
        </Menu>
      )}
    </header>
  )
}
