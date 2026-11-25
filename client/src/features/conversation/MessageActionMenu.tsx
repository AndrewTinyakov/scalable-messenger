import { CheckSquare, Copy, CornerUpLeft, Forward, Pencil, Pin, PinOff, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { Message } from '../../entities/message/model'
import type { ReaderPage } from '../../shared/api/featureDecode'
import { Menu, MenuItem, type MenuPoint } from '../../shared/ui/Menu'
import { InlineReaders } from './InlineReaders'

interface Props {
  message: Message
  anchor: HTMLElement
  point?: MenuPoint
  keyboard: boolean
  mine: boolean
  group?: boolean
  readers?: (chatId: string, messageId: string, afterUserId?: string) => Promise<ReaderPage>
  onReply(): void
  onEdit?: () => void
  onDelete(): void
  onSelect(): void
  pinned?: boolean
  onPin?: () => void
  onUnpin?: () => void
  onForward?: () => void
  onClose(): void
}

export function MessageActionMenu({
  message,
  anchor,
  point,
  keyboard,
  mine,
  group = false,
  readers,
  onReply,
  onEdit,
  onDelete,
  onSelect,
  pinned = false,
  onPin,
  onUnpin,
  onForward,
  onClose,
}: Props) {
  const [copyError, setCopyError] = useState(false)
  function action(callback: () => void) {
    anchor.closest<HTMLElement>('[data-message-id]')?.focus({ preventScroll: true })
    onClose()
    callback()
  }
  return (
    <Menu
      label="Message actions"
      anchor={anchor}
      point={point}
      align={mine ? 'end' : 'start'}
      keyboard={keyboard}
      onClose={() => action(() => {})}
      footer={
        <>
          {copyError && (
            <p className="popup-error" role="alert">
              Could not copy. Select the message text to copy it.
            </p>
          )}
          {mine && readers && (
            <InlineReaders key={message.id} message={message} group={group} load={readers} />
          )}
        </>
      }
    >
      <MenuItem icon={<CornerUpLeft size={18} />} onClick={() => action(onReply)}>
        Reply
      </MenuItem>
      {onEdit && !message.forwardedFromUserId && (
        <MenuItem icon={<Pencil size={18} />} onClick={() => action(onEdit)}>
          Edit
        </MenuItem>
      )}
      {pinned && onUnpin && (
        <MenuItem icon={<PinOff size={18} />} onClick={() => action(onUnpin)}>
          Unpin
        </MenuItem>
      )}
      {!pinned && onPin && (
        <MenuItem icon={<Pin size={18} />} onClick={() => action(onPin)}>
          Pin
        </MenuItem>
      )}
      <MenuItem
        icon={<Copy size={18} />}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(message.body)
            action(() => {})
          } catch {
            setCopyError(true)
          }
        }}
      >
        Copy text
      </MenuItem>
      {onForward && (
        <MenuItem icon={<Forward size={18} />} onClick={() => action(onForward)}>
          Forward
        </MenuItem>
      )}
      <MenuItem icon={<CheckSquare size={18} />} onClick={() => action(onSelect)}>
        Select
      </MenuItem>
      <MenuItem icon={<Trash2 size={18} />} danger onClick={() => action(onDelete)}>
        Delete
      </MenuItem>
    </Menu>
  )
}
