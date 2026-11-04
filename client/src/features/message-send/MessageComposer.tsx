import { ArrowUp, Check, CornerUpLeft, Pencil, X } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { Message } from '../../entities/message/model'

interface Props {
  chatId: string
  connected: boolean
  onSend: (chatId: string, body: string, replyToMessageId?: string) => boolean
  reply?: { message: Message; sender: string }
  edit?: Message
  onCancelMode?: () => void
  onSave?: (message: Message, body: string) => Promise<void>
}

export function MessageComposer({
  chatId,
  connected,
  onSend,
  reply,
  edit,
  onCancelMode,
  onSave,
}: Props) {
  const [draft, setDraft] = useState('')
  const [editDraft, setEditDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const active = useRef(true)
  const text = edit ? editDraft : draft
  const length = [...text].length
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  useEffect(() => {
    if (edit) setEditDraft(edit.body)
    setError(null)
    if (edit || reply) textareaRef.current?.focus()
  }, [edit?.id, reply?.message.id])

  async function send(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    if (saving || !connected || !text.trim()) return
    if (edit && onSave) {
      setSaving(true)
      setError(null)
      try {
        await onSave(edit, text.trim())
        if (active.current) onCancelMode?.()
      } catch (cause) {
        if (active.current)
          setError(cause instanceof Error ? cause.message : 'Could not save your edit')
      } finally {
        if (active.current) setSaving(false)
      }
    } else if (onSend(chatId, draft, reply?.message.id)) {
      setDraft('')
      onCancelMode?.()
      textareaRef.current?.focus()
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape' && (edit || reply) && !saving) {
      event.preventDefault()
      onCancelMode?.()
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send()
    }
  }

  return (
    <div className="composer-wrap">
      {(reply || edit) && (
        <div className={`composer-mode ${edit ? 'editing' : ''}`}>
          {edit ? <Pencil size={17} /> : <CornerUpLeft size={17} />}
          <div>
            <strong>{edit ? 'Editing your message' : `Reply to ${reply?.sender}`}</strong>
            <span>
              {edit
                ? edit.body
                : reply?.message.deletedAt
                  ? 'Message deleted'
                  : reply?.message.body}
            </span>
          </div>
          <button
            className="icon-button"
            disabled={saving}
            onClick={onCancelMode}
            aria-label={edit ? 'Cancel edit' : 'Cancel reply'}
          >
            <X size={17} />
          </button>
        </div>
      )}
      <form className="composer" onSubmit={(event) => void send(event)}>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(event) =>
            (edit ? setEditDraft : setDraft)([...event.target.value].slice(0, 4000).join(''))
          }
          onKeyDown={onKeyDown}
          placeholder={connected ? 'Write a message…' : 'Waiting for connection…'}
          disabled={!connected || saving}
          rows={1}
          aria-label={edit ? 'Edit message' : 'Write a message'}
        />
        <button
          type="submit"
          className="send-button"
          disabled={!text.trim() || length > 4000 || !connected || saving}
          aria-label={edit ? (saving ? 'Saving edit' : 'Save edit') : 'Send message'}
        >
          {edit ? <Check size={20} /> : <ArrowUp size={20} strokeWidth={2.2} />}
        </button>
      </form>
      {error && (
        <p className="composer-error" role="alert">
          {error}
        </p>
      )}
      <div className="composer-foot">
        <span>{saving ? 'Saving your edit…' : 'Enter to send · Shift+Enter for a new line'}</span>
        {length > 0 && <span>{length}/4000</span>}
      </div>
    </div>
  )
}
