import { Eraser, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import type { Chat } from '../../entities/chat/model'
import type { DeleteScope } from '../../entities/message/historySnapshot'
import type { User } from '../../entities/session/model'
import { ChatKind } from '../../shared/api/generated/socket-vocabulary'
import { Menu, MenuItem, type MenuPoint } from '../../shared/ui/Menu'
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
  onClose(): void
}

export function ChatActions({ target, user, onDelete, onClear, onClose }: Props) {
  const { chat, anchor, keyboard, point } = target
  const [confirm, setConfirm] = useState<'chat' | 'history' | null>(null)
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

  if (confirm)
    return (
      <DeleteConfirmation
        target={{ kind: confirm }}
        canDeleteEveryone={chat.kind === ChatKind.DIRECT || chat.ownerId === user.id}
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
      <MenuItem icon={<Eraser size={18} />} onClick={() => setConfirm('history')}>
        Clear history
      </MenuItem>
      <MenuItem icon={<Trash2 size={18} />} danger onClick={() => setConfirm('chat')}>
        Delete chat
      </MenuItem>
    </Menu>
  )
}
