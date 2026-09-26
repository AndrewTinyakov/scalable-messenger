import { useEffect, useRef } from 'react'
import { ArrowLeft, Hash, MessageSquare, UsersRound } from 'lucide-react'
import { conversationInitials, conversationTitle, type Conversation } from '../../entities/conversation/model'
import { MessageItem } from '../../entities/message/MessageItem'
import type { Message, PendingSend } from '../../entities/message/model'
import type { User } from '../../entities/session/model'
import { MessageComposer } from '../../features/message-send/MessageComposer'

interface Props {
  conversation: Conversation | undefined
  currentUser: User
  messages: Message[]
  pending: PendingSend[]
  connection: 'connecting' | 'connected' | 'offline'
  onSend: (conversationId: string, body: string) => boolean
  onRetry: (requestId: string) => void
  onBack: () => void
  onNew: () => void
}

export function ConversationPanel({ conversation, currentUser, messages, pending, connection, onSend, onRetry, onBack, onNew }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }) }, [conversation?.id, messages.length, pending.length])

  if (!conversation) return <section className="conversation-panel empty-panel"><div className="empty-panel-art"><MessageSquare size={46} strokeWidth={1.2} /><span className="empty-art-spark">✳</span></div><div className="empty-eyebrow">YOUR CONVERSATIONS</div><h2>The next message<br />starts here.</h2><p>Find someone you know or bring a group together.</p><button className="button button-primary" onClick={onNew}>Start a conversation</button></section>

  const senderNames = new Map(conversation.members.map((member) => [member.id, member.username]))
  const unsaved = pending.filter((send) => send.conversationId === conversation.id && !messages.some((message) => message.id === send.messageId))
  const entries = [
    ...messages.map((message) => ({ key: message.id, message, send: undefined as PendingSend | undefined })),
    ...unsaved.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((send) => ({ key: send.requestId, message: undefined as Message | undefined, send })),
  ]

  return <section className="conversation-panel">
    <header className="chat-header">
      <button className="icon-button mobile-back" onClick={onBack} aria-label="Back to conversations"><ArrowLeft size={20} /></button>
      <span className={`chat-header-avatar ${conversation.kind === 'group' ? 'group-avatar' : ''}`}>{conversation.kind === 'group' ? <UsersRound size={22} /> : conversationInitials(conversation, currentUser.id)}</span>
      <div className="chat-header-info"><h2>{conversationTitle(conversation, currentUser.id)}</h2><p>{conversation.kind === 'group' ? `${conversation.members.length} members` : 'Direct conversation'}</p></div>
      <span className={`connection-pill ${connection}`}><span />{connection === 'connected' ? 'Live' : connection === 'connecting' ? 'Connecting' : 'Offline'}</span>
    </header>

    <div className="chat-body" role="log" aria-label="Messages" aria-live="polite">
      <div className="chat-body-inner">
        <div className="conversation-start"><div className="start-icon">{conversation.kind === 'group' ? <UsersRound size={24} /> : <Hash size={24} />}</div><span>THE BEGINNING OF THIS CONVERSATION</span><p>{conversation.kind === 'group' ? 'A space for everyone in this group.' : 'A space for the two of you.'}</p></div>
        {entries.map(({ key, message, send }) => {
          const mine = Boolean(send || message?.senderId === currentUser.id)
          const sender = send ? currentUser.username : senderNames.get(message?.senderId || '') || 'Member'
          return <MessageItem key={key} message={message} send={send} mine={mine} sender={sender} group={conversation.kind === 'group'} connected={connection === 'connected'} onRetry={onRetry} />
        })}
        <div ref={bottomRef} />
      </div>
    </div>

    <MessageComposer conversationId={conversation.id} connected={connection === 'connected'} onSend={onSend} />
  </section>
}
