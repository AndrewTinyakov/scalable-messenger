import { Check, CheckCheck, CircleAlert, RotateCw } from 'lucide-react'
import type { Message, PendingSend } from './model'
import { formatMessageTime } from '../../shared/lib/time'

interface Props {
  message?: Message
  send?: PendingSend
  mine: boolean
  sender: string
  group: boolean
  connected: boolean
  onRetry: (requestId: string) => void
}

function SendStateIcon({ state }: { state: PendingSend['status'] }) {
  if (state === 'rejected' || state === 'retryable') return <CircleAlert size={13} />
  if (state === 'saved') return <CheckCheck size={13} />
  if (state === 'queued') return <Check size={13} />
  return <RotateCw size={12} className="spin" />
}

export function MessageItem({ message, send, mine, sender, group, connected, onRetry }: Props) {
  const state = send?.status || (mine ? 'saved' : undefined)
  return <div className={`message-row ${mine ? 'mine' : ''}`}>
    {!mine && <span className="message-avatar">{sender[0]?.toUpperCase()}</span>}
    <div className="message-stack">
      {group && !mine && <span className="message-sender">{sender}</span>}
      <div className={`message-bubble ${send?.status === 'rejected' || send?.status === 'retryable' ? 'rejected' : ''}`}>{message?.body || send?.body}</div>
      <div className="message-meta"><time>{formatMessageTime(message?.createdAt ?? send?.createdAt ?? '')}</time>{state && <span className={`send-state ${state}`}><SendStateIcon state={state} />{state === 'sending' ? 'Sending' : state === 'queued' ? 'Queued' : state === 'saved' ? 'Saved' : state === 'retryable' ? 'Not queued' : 'Rejected'}</span>}</div>
      {send?.status === 'rejected' && <div className="rejection-reason">{send.reason || 'This message could not be saved.'}</div>}
      {send?.status === 'retryable' && <div className="retry-wrap"><span>{send.reason}</span><button className="retry-send" type="button" onClick={() => onRetry(send.requestId)} disabled={!connected}>Try again</button></div>}
    </div>
  </div>
}
