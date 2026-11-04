import type { Message } from '../../entities/message/model'
import { Dialog } from '../../shared/ui/Dialog'

interface Props {
  target: Message | 'chat'
  busy: boolean
  error: string | null
  onCancel(): void
  onConfirm(): void
}
export function DeleteConfirmation({ target, busy, error, onCancel, onConfirm }: Props) {
  return (
    <Dialog
      title={target === 'chat' ? 'Delete this chat?' : 'Delete this message?'}
      onClose={onCancel}
      busy={busy}
    >
      <p className="dialog-description">
        {target === 'chat'
          ? 'This permanently removes this conversation and its messages for every member. Everyone will lose access to its history.'
          : 'This removes the message for everyone. Its place in the conversation will remain.'}
      </p>
      {target !== 'chat' && <blockquote className="delete-preview">{target.body}</blockquote>}
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
        <button className="button button-danger" disabled={busy} onClick={onConfirm}>
          {busy ? 'Deleting…' : target === 'chat' ? 'Delete for everyone' : 'Delete message'}
        </button>
      </div>
    </Dialog>
  )
}
