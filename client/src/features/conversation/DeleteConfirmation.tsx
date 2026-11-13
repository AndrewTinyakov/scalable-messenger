import { useState } from 'react'
import type { DeleteScope } from '../../entities/message/historySnapshot'
import type { Message } from '../../entities/message/model'
import { Dialog } from '../../shared/ui/Dialog'

export type DeletionTarget =
  { kind: 'messages'; messages: Message[] } | { kind: 'history' } | { kind: 'chat' }

interface Props {
  target: DeletionTarget
  canDeleteEveryone: boolean
  peerName?: string
  busy: boolean
  error: string | null
  onCancel(): void
  onConfirm(scope: DeleteScope): void
}
export function DeleteConfirmation({
  target,
  canDeleteEveryone,
  peerName,
  busy,
  error,
  onCancel,
  onConfirm,
}: Props) {
  const [everyone, setEveryone] = useState(false)
  const verb = target.kind === 'history' ? 'clear' : 'delete'
  const noun =
    target.kind === 'chat'
      ? 'this chat'
      : target.kind === 'history'
        ? 'the history of this chat'
        : target.messages.length === 1
          ? 'this message'
          : `these ${target.messages.length} messages`
  const title = `Do you want to ${verb} ${noun}?`
  const audience = peerName
    ? `Also ${verb} for ${peerName}`
    : `${verb === 'clear' ? 'Clear' : 'Delete'} for all members`
  return (
    <Dialog title={title} onClose={onCancel} busy={busy} compact>
      {canDeleteEveryone && (
        <label className="dialog-check">
          <input
            type="checkbox"
            value="EVERYONE"
            checked={everyone}
            disabled={busy}
            onChange={(event) => setEveryone(event.target.checked)}
          />
          {audience}
        </label>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button className="button button-ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button
          className="button button-danger-ghost"
          disabled={busy}
          onClick={() => onConfirm(canDeleteEveryone && everyone ? 'EVERYONE' : 'SELF')}
        >
          {busy
            ? verb === 'clear'
              ? 'Clearing…'
              : 'Deleting…'
            : verb === 'clear'
              ? 'Clear'
              : 'Delete'}
        </button>
      </div>
    </Dialog>
  )
}
