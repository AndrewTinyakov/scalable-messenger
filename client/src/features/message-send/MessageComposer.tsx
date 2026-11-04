import { Check, CornerUpLeft, Pencil, SendHorizontal, X } from 'lucide-react'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import type { Message } from '../../entities/message/model'

const MAX_LENGTH = 4000
const COUNTER_THRESHOLD = 3600
const MAX_INPUT_HEIGHT = 216

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
  useLayoutEffect(() => {
    const input = textareaRef.current
    if (!input) return
    input.style.height = 'auto'
    const height = Math.min(input.scrollHeight, MAX_INPUT_HEIGHT)
    input.style.height = `${height}px`
    input.style.overflowY = input.scrollHeight > MAX_INPUT_HEIGHT ? 'auto' : 'hidden'
  }, [text])

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
      {error && (
        <p className="composer-error" role="alert">
          {error}
        </p>
      )}
      <form className="composer" onSubmit={(event) => void send(event)}>
        <div className="composer-field">
          {(reply || edit) && (
            <div className={`composer-mode ${edit ? 'editing' : ''}`}>
              {edit ? <Pencil size={18} /> : <CornerUpLeft size={18} />}
              <div>
                <strong>{edit ? 'Edit message' : `Reply to ${reply?.sender}`}</strong>
                <span>
                  {edit
                    ? edit.body
                    : reply?.message.deletedAt
                      ? 'Message deleted'
                      : reply?.message.body}
                </span>
              </div>
              <button
                type="button"
                className="icon-button"
                disabled={saving}
                onClick={onCancelMode}
                aria-label={edit ? 'Cancel edit' : 'Cancel reply'}
              >
                <X size={18} />
              </button>
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(event) =>
              (edit ? setEditDraft : setDraft)(
                [...event.target.value].slice(0, MAX_LENGTH).join(''),
              )
            }
            onKeyDown={onKeyDown}
            placeholder="Write a message…"
            disabled={saving}
            rows={1}
            aria-label={edit ? 'Edit message' : 'Write a message'}
          />
          {length >= COUNTER_THRESHOLD && (
            <span className="composer-count">{MAX_LENGTH - length}</span>
          )}
        </div>
        <button
          type="submit"
          className="send-button"
          disabled={!text.trim() || length > MAX_LENGTH || !connected || saving}
          aria-label={edit ? (saving ? 'Saving edit' : 'Save edit') : 'Send message'}
        >
          {edit ? <Check size={22} /> : <SendHorizontal size={21} />}
        </button>
      </form>
    </div>
  )
}
