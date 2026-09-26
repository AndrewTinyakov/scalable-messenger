import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { ArrowUp } from 'lucide-react'

interface Props {
  conversationId: string
  connected: boolean
  onSend: (conversationId: string, body: string) => boolean
}

export function MessageComposer({ conversationId, connected, onSend }: Props) {
  const [draft, setDraft] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { setDraft('') }, [conversationId])

  function send(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    if (onSend(conversationId, draft)) {
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
    <div className="composer-foot"><span>ENTER TO SEND · SHIFT + ENTER FOR A NEW LINE</span><span>{draft.length > 0 ? `${draft.length}/4000` : 'Messages are saved to your history'}</span></div>
  </div>
}
