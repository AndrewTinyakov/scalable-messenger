import { ArrowLeft, Bell, BellOff, Eraser, MoreVertical, Trash2, UsersRound } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { chatTitle, type Chat } from '../../entities/chat/model'
import type { User } from '../../entities/session/model'
import { MembersPreview, type MemberPage } from '../../features/group-members/MembersPreview'
import { isOnline, presenceLabel } from '../../features/presence/presenceLabel'
import { useOnlineCount, usePresence } from '../../features/presence/usePresence'
import { ChatKind } from '../../shared/api/generated/socket-vocabulary'
import { Avatar } from '../../shared/ui/Avatar'
import { Menu, MenuItem } from '../../shared/ui/Menu'

interface Props {
  chat: Chat
  currentUser: User
  onBack(): void
  onMembers?: () => void
  loadMembers?: (chatId: string, after?: string) => Promise<MemberPage>
  onDelete?: () => void
  onClear?: () => void
  muted?: boolean
  onMute?: () => void
  onUnmute?: () => void
}

export const LIVE_ONLINE_COUNT_MAX_MEMBERS = 200

function useSubtitle(chat: Chat, recipient: string | undefined): { text: string; online: boolean } {
  const group = chat.kind === ChatKind.GROUP
  const statuses = usePresence('header', recipient ? [recipient] : [])
  const counted =
    group && !chat.id.startsWith('draft:') && chat.memberCount <= LIVE_ONLINE_COUNT_MAX_MEMBERS
  const count = useOnlineCount(counted ? chat.id : undefined, chat.memberCount)
  if (group) {
    const members = `${chat.memberCount} ${chat.memberCount === 1 ? 'member' : 'members'}`
    return { text: count ? `${members}, ${count.online} online` : members, online: false }
  }
  const status = recipient ? statuses.get(recipient) : undefined
  return { text: presenceLabel(status), online: isOnline(status) }
}

export function ChatHeader({
  chat,
  currentUser,
  onBack,
  onMembers,
  loadMembers,
  onDelete,
  onClear,
  muted = false,
  onMute,
  onUnmute,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [preview, setPreview] = useState(false)
  const previewTimer = useRef<ReturnType<typeof setTimeout>>()
  const showPreview = (open: boolean) => {
    clearTimeout(previewTimer.current)
    previewTimer.current = setTimeout(() => setPreview(open), open ? 300 : 200)
  }
  useEffect(() => () => clearTimeout(previewTimer.current), [])
  const actionsRef = useRef<HTMLButtonElement>(null)
  const group = chat.kind === ChatKind.GROUP
  const recipient = group
    ? undefined
    : chat.members.find((member) => member.id !== currentUser.id)?.id
  const title = chatTitle(chat, currentUser.id)
  const status = useSubtitle(chat, recipient)
  useEffect(() => {
    clearTimeout(previewTimer.current)
    setMenuOpen(false)
    setPreview(false)
  }, [chat.id])

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
        {group && onMembers ? (
          <div
            className="chat-header-members"
            onMouseEnter={() => loadMembers && showPreview(true)}
            onMouseLeave={() => showPreview(false)}
          >
            <button onClick={onMembers} aria-label="Show members">
              {status.text}
            </button>
            {preview && loadMembers && (
              <MembersPreview chatId={chat.id} ownerId={chat.ownerId} load={loadMembers} />
            )}
          </div>
        ) : (
          <p key={status.text} className={status.online ? 'online' : undefined}>
            {status.text}
          </p>
        )}
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
