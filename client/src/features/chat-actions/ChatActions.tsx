import {
  ArrowDown,
  ArrowUp,
  Bell,
  BellOff,
  Eraser,
  MessageCircleMore,
  MessageSquareText,
  Pin,
  PinOff,
  Trash2,
} from 'lucide-react'
import { useRef, useState } from 'react'
import { chatTitle, hasUnread, isMuted, type Chat } from '../../entities/chat/model'
import type { DeleteScope } from '../../entities/message/historySnapshot'
import type { User } from '../../entities/session/model'
import { ChatKind } from '../../shared/api/generated/socket-vocabulary'
import { Menu, MenuItem, type MenuPoint } from '../../shared/ui/Menu'
import { MuteDialog } from '../chat-preferences/MuteDialog'
import { DeleteConfirmation } from '../conversation/DeleteConfirmation'

export interface ChatMenuTarget {
  chat: Chat
  anchor: HTMLElement
  keyboard: boolean
  point?: MenuPoint
}

interface Props {
  target: ChatMenuTarget
  user: User
  onDelete(chatId: string, scope: DeleteScope): Promise<void>
  onClear(chatId: string, scope: DeleteScope): Promise<void>
  pinnedOrder?: string[]
  onPin?: (chatId: string, pinned: boolean) => Promise<void>
  onMovePinned?: (chatId: string, offset: number) => Promise<void>
  onMute?: (chatId: string, durationSeconds: number | null) => Promise<void>
  onUnmute?: (chatId: string) => Promise<void>
  onMarkUnread?: (chat: Chat, unread: boolean) => Promise<void>
  onError?: (message: string) => void
  onClose(): void
}

export function ChatActions({
  target,
  user,
  onDelete,
  onClear,
  pinnedOrder = [],
  onPin,
  onMovePinned,
  onMute,
  onUnmute,
  onMarkUnread,
  onError,
  onClose,
}: Props) {
  const { chat, anchor, keyboard, point } = target
  const [confirm, setConfirm] = useState<'chat' | 'history' | null>(null)
  const [muting, setMuting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)

  async function submit(scope: DeleteScope) {
    if (busyRef.current || !confirm) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await (confirm === 'chat' ? onDelete : onClear)(chat.id, scope)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not complete this action')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  function run(action: () => Promise<void>) {
    onClose()
    anchor.focus({ preventScroll: true })
    void action().catch((cause: unknown) =>
      onError?.(cause instanceof Error ? cause.message : 'Could not update this chat'),
    )
  }
  const pinned = chat.pinnedRank != null
  const pinIndex = pinnedOrder.indexOf(chat.id)
  const muted = isMuted(chat)
  const unread = hasUnread(chat)

  if (muting && onMute)
    return (
      <MuteDialog
        title={chatTitle(chat, user.id)}
        onCancel={onClose}
        onMute={(seconds) => onMute(chat.id, seconds)}
      />
    )

  if (confirm)
    return (
      <DeleteConfirmation
        target={{ kind: confirm }}
        canDeleteEveryone={chat.kind === ChatKind.DIRECT || chat.ownerId === user.id}
        peerName={chat.kind === ChatKind.DIRECT ? chatTitle(chat, user.id) : undefined}
        busy={busy}
        error={error}
        onCancel={onClose}
        onConfirm={(scope) => void submit(scope)}
      />
    )

  return (
    <Menu
      label="Chat options"
      anchor={anchor}
      point={point}
      keyboard={keyboard}
      onClose={() => {
        anchor.focus({ preventScroll: true })
        onClose()
      }}
    >
      {onPin && (
        <MenuItem
          icon={pinned ? <PinOff size={18} /> : <Pin size={18} />}
          onClick={() => run(() => onPin(chat.id, !pinned))}
        >
          {pinned ? 'Unpin' : 'Pin'}
        </MenuItem>
      )}
      {pinned && onMovePinned && pinIndex > 0 && (
        <MenuItem icon={<ArrowUp size={18} />} onClick={() => run(() => onMovePinned(chat.id, -1))}>
          Move up
        </MenuItem>
      )}
      {pinned && onMovePinned && pinIndex >= 0 && pinIndex < pinnedOrder.length - 1 && (
        <MenuItem
          icon={<ArrowDown size={18} />}
          onClick={() => run(() => onMovePinned(chat.id, 1))}
        >
          Move down
        </MenuItem>
      )}
      {muted && onUnmute && (
        <MenuItem icon={<Bell size={18} />} onClick={() => run(() => onUnmute(chat.id))}>
          Unmute
        </MenuItem>
      )}
      {!muted && onMute && (
        <MenuItem icon={<BellOff size={18} />} onClick={() => setMuting(true)}>
          Mute notifications
        </MenuItem>
      )}
      {onMarkUnread && (
        <MenuItem
          icon={unread ? <MessageSquareText size={18} /> : <MessageCircleMore size={18} />}
          onClick={() => run(() => onMarkUnread(chat, !unread))}
        >
          {unread ? 'Mark as read' : 'Mark as unread'}
        </MenuItem>
      )}
      <MenuItem icon={<Eraser size={18} />} onClick={() => setConfirm('history')}>
        Clear history
      </MenuItem>
      <MenuItem icon={<Trash2 size={18} />} danger onClick={() => setConfirm('chat')}>
        Delete chat
      </MenuItem>
    </Menu>
  )
}
