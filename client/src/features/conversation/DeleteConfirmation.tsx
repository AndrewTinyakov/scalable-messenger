import { useState } from 'react'
import type { DeleteScope } from '../../entities/message/historySnapshot'
import type { Message } from '../../entities/message/model'
import { Dialog } from '../../shared/ui/Dialog'

export type DeletionTarget =
  { kind: 'messages'; messages: Message[] } | { kind: 'history' } | { kind: 'chat' }

interface Props {
  target: DeletionTarget
  canDeleteEveryone: boolean
  busy: boolean
  error: string | null
  onCancel(): void
  onConfirm(scope: DeleteScope): void
}
export function DeleteConfirmation({
  target,
  canDeleteEveryone,
  busy,
  error,
  onCancel,
  onConfirm,
}: Props) {
  const [scope, setScope] = useState<DeleteScope>('SELF')
  const noun =
    target.kind === 'chat'
      ? 'chat'
      : target.kind === 'history'
        ? 'history'
        : target.messages.length === 1
          ? 'message'
          : `${target.messages.length} messages`
  const title =
    target.kind === 'history'
      ? 'Clear this history?'
      : `Delete ${target.kind === 'messages' && target.messages.length > 1 ? 'these' : 'this'} ${noun}?`
  return (
    <Dialog title={title} onClose={onCancel} busy={busy}>
      <p className="dialog-description">
        {scope === 'EVERYONE'
          ? target.kind === 'chat'
            ? 'Permanently remove this chat and its messages for every member.'
            : target.kind === 'history'
              ? 'Permanently remove the current messages for every member. The chat stays available for new messages.'
              : 'Permanently remove the selected messages for every member.'
          : target.kind === 'chat'
            ? 'Remove this chat and its current history from your account on every device. A new message will bring the chat back.'
            : target.kind === 'history'
              ? 'Hide the current messages from your account on every device. The empty chat stays in your list.'
              : 'Hide the selected messages from your account on every device. Other members keep their copies.'}
      </p>
      {target.kind === 'messages' && target.messages.length === 1 && (
        <blockquote className="delete-preview">{target.messages[0].body}</blockquote>
      )}
      <fieldset className="deletion-scopes" disabled={busy}>
        <legend>Delete for</legend>
        <label>
          <input
            type="radio"
            name="deletion-scope"
            value="SELF"
            checked={scope === 'SELF'}
            onChange={() => setScope('SELF')}
          />
          Only me
        </label>
        {canDeleteEveryone && (
          <label>
            <input
              type="radio"
              name="deletion-scope"
              value="EVERYONE"
              checked={scope === 'EVERYONE'}
              onChange={() => setScope('EVERYONE')}
            />
            Everyone
          </label>
        )}
      </fieldset>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {busy && <p role="status">Deleting…</p>}
      <div className="dialog-actions">
        <button className="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button
          className="button button-danger"
          disabled={busy}
          onClick={() => onConfirm(canDeleteEveryone ? scope : 'SELF')}
        >
          {busy
            ? 'Deleting…'
            : `${target.kind === 'history' ? 'Clear' : 'Delete'} for ${scope === 'EVERYONE' && canDeleteEveryone ? 'everyone' : 'me'}`}
        </button>
      </div>
    </Dialog>
  )
}
