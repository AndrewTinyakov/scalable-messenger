import { useState } from 'react'
import type { Message } from '../../entities/message/model'
import { Dialog } from '../../shared/ui/Dialog'
import type { PinScope } from './useMessagePins'

interface Props {
  message: Message
  peerName?: string
  onCancel(): void
  onPin(scope: PinScope): Promise<void>
}

export function PinMessageDialog({ message, peerName, onCancel, onPin }: Props) {
  const [forPeer, setForPeer] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function submit() {
    setBusy(true)
    setError(null)
    try {
      await onPin(peerName === undefined || forPeer ? 'EVERYONE' : 'SELF')
      onCancel()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not pin this message')
      setBusy(false)
    }
  }
  return (
    <Dialog title="Pin message" onClose={onCancel} busy={busy}>
      <p className="dialog-description">
        {peerName === undefined
          ? 'Pin this message at the top of the chat for all members?'
          : 'Pin this message at the top of the chat?'}
      </p>
      <blockquote className="delete-preview">{message.body}</blockquote>
      {peerName !== undefined && (
        <label className="dialog-check">
          <input
            type="checkbox"
            checked={forPeer}
            disabled={busy}
            onChange={(event) => setForPeer(event.target.checked)}
          />
          Also pin for {peerName}
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
        <button className="button button-primary" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Pinning…' : 'Pin'}
        </button>
      </div>
    </Dialog>
  )
}
