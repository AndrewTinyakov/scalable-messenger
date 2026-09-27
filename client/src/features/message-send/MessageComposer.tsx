import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { ArrowUp } from 'lucide-react'

interface Props {
  chatId: string
  connected: boolean
  onSend: (chatId: string, body: string) => boolean
}

export function MessageComposer({ chatId, connected, onSend }: Props) {
  const [draft, setDraft] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { setDraft('') }, [chatId])

  function send(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    if (onSend(chatId, draft)) {
      setDraft('')
      textareaRef.current?.focus()
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send() }
  }

  return <div className="composer-wrap">
    <form className="composer" onSubmit={send}>
      <textarea ref={textareaRef} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown} placeholder={connected ? 'Write a message…' : 'Waiting for connection…'} disabled={!connected} rows={1} maxLength={4000} aria-label="Write a message" />
      <button type="submit" className="send-button" disabled={!draft.trim() || !connected} aria-label="Send message"><ArrowUp size={20} strokeWidth={2.2} /></button>
    </form>
    <div className="composer-foot"><span>Enter to send · Shift+Enter for a new line</span>{draft.length > 0 && <span>{draft.length}/4000</span>}</div>
  </div>
}
