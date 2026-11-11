import { useState } from 'react'
import { Dialog } from '../../shared/ui/Dialog'

export const MUTE_OPTIONS: { label: string; seconds: number | null }[] = [
  { label: 'For 1 hour', seconds: 60 * 60 },
  { label: 'For 8 hours', seconds: 8 * 60 * 60 },
  { label: 'For 1 day', seconds: 24 * 60 * 60 },
  { label: 'For 7 days', seconds: 7 * 24 * 60 * 60 },
  { label: 'Forever', seconds: null },
]

interface Props {
  title: string
  onCancel(): void
  onMute(durationSeconds: number | null): Promise<void>
}

export function MuteDialog({ title, onCancel, onMute }: Props) {
  const [choice, setChoice] = useState(MUTE_OPTIONS.length - 1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function submit() {
    setBusy(true)
    setError(null)
    try {
      await onMute(MUTE_OPTIONS[choice].seconds)
      onCancel()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not mute this chat')
      setBusy(false)
    }
  }
  return (
    <Dialog title="Mute notifications" onClose={onCancel} busy={busy}>
      <p className="dialog-description">Silence sounds and alerts from {title}.</p>
      <fieldset className="deletion-scopes" disabled={busy}>
        <legend className="visually-hidden">Mute for</legend>
        {MUTE_OPTIONS.map((option, index) => (
          <label key={option.label}>
            <input
              type="radio"
              name="mute-duration"
              checked={choice === index}
              onChange={() => setChoice(index)}
            />
            {option.label}
          </label>
        ))}
      </fieldset>
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
          {busy ? 'Muting…' : 'Mute'}
        </button>
      </div>
    </Dialog>
  )
}
