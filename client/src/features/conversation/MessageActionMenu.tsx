import { CheckSquare, Copy, CornerUpLeft, Pencil, Trash2 } from 'lucide-react'
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
  readers?: (chatId: string, messageId: string, afterUserId?: string) => Promise<ReaderPage>
  onReply(): void
  onEdit?: () => void
  onDelete(): void
  onSelect(): void
  onClose(): void
}

export function MessageActionMenu({
  message,
  anchor,
  point,
  keyboard,
  mine,
  readers,
  onReply,
  onEdit,
  onDelete,
  onSelect,
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
          {mine && readers && <InlineReaders key={message.id} message={message} load={readers} />}
        </>
      }
    >
      <MenuItem icon={<CornerUpLeft size={18} />} onClick={() => action(onReply)}>
        Reply
      </MenuItem>
      {onEdit && (
        <MenuItem icon={<Pencil size={18} />} onClick={() => action(onEdit)}>
          Edit
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
        Copy
      </MenuItem>
      <MenuItem icon={<CheckSquare size={18} />} onClick={() => action(onSelect)}>
        Select
      </MenuItem>
      <MenuItem icon={<Trash2 size={18} />} danger onClick={() => action(onDelete)}>
        Delete
      </MenuItem>
    </Menu>
  )
}
