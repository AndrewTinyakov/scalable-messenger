import {
  Bell,
  BellOff,
  LogOut,
  Menu as MenuIcon,
  MessageCircleMore,
  MessageSquarePlus,
  MessagesSquare,
  ShieldCheck,
  User as UserIcon,
  UsersRound,
  Volume2,
  VolumeX,
  type LucideIcon,
} from 'lucide-react'
import { useRef, useState } from 'react'
import { formatUnread } from '../../entities/chat/model'
import type { User } from '../../entities/session/model'
import {
  notificationPermission,
  useNotificationSettings,
} from '../../features/notifications/notificationSettings'
import { playNotificationSound } from '../../features/notifications/notificationSound'
import { Avatar } from '../../shared/ui/Avatar'
import { Menu, MenuItem } from '../../shared/ui/Menu'

export type ChatFolder = 'all' | 'unread' | 'direct' | 'groups'

const FOLDERS: { id: ChatFolder; label: string; icon: LucideIcon }[] = [
  { id: 'all', label: 'All chats', icon: MessagesSquare },
  { id: 'unread', label: 'Unread', icon: MessageCircleMore },
  { id: 'direct', label: 'Personal', icon: UserIcon },
  { id: 'groups', label: 'Groups', icon: UsersRound },
]

interface Props {
  user: User
  folder: ChatFolder
  unreadChats: Record<ChatFolder, number>
  onFolder(folder: ChatFolder): void
  onCreate(mode: 'direct' | 'group'): void
  onSecurity(): void
  onSignOut(): void
}

export function FolderRail({
  user,
  folder,
  unreadChats,
  onFolder,
  onCreate,
  onSecurity,
  onSignOut,
}: Props) {
  const [open, setOpen] = useState(false)
  const { settings, update } = useNotificationSettings()
  const permission = notificationPermission()
  const desktopOn = settings.desktop && permission === 'granted'
  const menuRef = useRef<HTMLButtonElement>(null)
  function run(action: () => void) {
    setOpen(false)
    action()
  }
  return (
    <nav className="rail" aria-label="Chat folders">
      <button
        ref={menuRef}
        className="rail-menu"
        aria-label="Main menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <MenuIcon size={22} />
      </button>
      {FOLDERS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          className={`rail-folder ${folder === id ? 'active' : ''}`}
          aria-pressed={folder === id}
          onClick={() => onFolder(id)}
        >
          <span className="rail-folder-icon">
            <Icon size={24} strokeWidth={1.9} />
            {unreadChats[id] > 0 && <b>{formatUnread(unreadChats[id])}</b>}
          </span>
          <span>{label}</span>
        </button>
      ))}
      {open && menuRef.current && (
        <Menu label="Main menu" anchor={menuRef.current} onClose={() => setOpen(false)}>
          <div className="menu-account">
            <Avatar seed={user.id} name={user.username} size={40} />
            <strong>{user.username}</strong>
          </div>
          <MenuItem
            icon={<MessageSquarePlus size={18} />}
            onClick={() => run(() => onCreate('direct'))}
          >
            New chat
          </MenuItem>
          <MenuItem icon={<UsersRound size={18} />} onClick={() => run(() => onCreate('group'))}>
            New group
          </MenuItem>
          {permission !== 'unsupported' && (
            <MenuItem
              icon={desktopOn ? <Bell size={18} /> : <BellOff size={18} />}
              role="menuitemcheckbox"
              aria-checked={desktopOn}
              disabled={permission === 'denied'}
              title={
                permission === 'denied'
                  ? 'Notifications are blocked in browser settings'
                  : undefined
              }
              onClick={() => void update({ desktop: !desktopOn })}
            >
              {permission === 'denied'
                ? 'Notifications blocked'
                : `Desktop notifications: ${desktopOn ? 'on' : 'off'}`}
            </MenuItem>
          )}
          <MenuItem
            icon={settings.sound ? <Volume2 size={18} /> : <VolumeX size={18} />}
            role="menuitemcheckbox"
            aria-checked={settings.sound}
            onClick={() => {
              const sound = !settings.sound
              void update({ sound })
              if (sound) playNotificationSound()
            }}
          >
            Sound: {settings.sound ? 'on' : 'off'}
          </MenuItem>
          <MenuItem icon={<ShieldCheck size={18} />} onClick={() => run(onSecurity)}>
            Devices and password
          </MenuItem>
          <MenuItem icon={<LogOut size={18} />} danger onClick={() => run(onSignOut)}>
            Sign out
          </MenuItem>
        </Menu>
      )}
    </nav>
  )
}
