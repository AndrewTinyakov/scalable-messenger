import { useState } from 'react'
import { LogOut, MessageCirclePlus, Search, UsersRound } from 'lucide-react'
import { conversationInitials, conversationTitle, type Conversation } from '../../entities/conversation/model'
import type { Message } from '../../entities/message/model'
import type { User } from '../../entities/session/model'
import { formatConversationTime } from '../../shared/lib/time'
import { Brand } from '../../shared/ui/Brand'

interface Props {
  user: User
  conversations: Conversation[]
  messages: Record<string, Message[]>
  selectedId: string | null
  onSelect: (id: string) => void
  onCreate: () => void
  onSignOut: () => void
}

export function ConversationList({ user, conversations, messages, selectedId, onSelect, onCreate, onSignOut }: Props) {
  const [filter, setFilter] = useState('')
  const visible = conversations.filter((item) => conversationTitle(item, user.id).toLowerCase().includes(filter.toLowerCase()))

  return (
    <aside className="sidebar">
      <div className="sidebar-header"><Brand compact /><button className="icon-button sidebar-create" onClick={onCreate} aria-label="New conversation" title="New conversation"><MessageCirclePlus size={20} strokeWidth={1.8} /></button></div>
      <div className="sidebar-intro"><div className="sidebar-eyebrow">YOUR SPACE</div><h1>Messages<span>.</span></h1><p>All your conversations, in one place.</p></div>
      <label className="sidebar-search"><Search size={18} strokeWidth={1.8} /><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search conversations" aria-label="Search conversations" /></label>
      <div className="conversation-list-heading"><span>RECENT</span><span>{conversations.length.toString().padStart(2, '0')}</span></div>
      <nav className="conversation-list" aria-label="Conversations">
        {visible.length === 0 && <div className="conversation-list-empty">{conversations.length ? 'No conversations match your search.' : 'A good conversation starts somewhere. Use the plus button to begin.'}</div>}
        {visible.map((item) => {
          const last = messages[item.id]?.at(-1)
          return <button key={item.id} className={`conversation-item ${selectedId === item.id ? 'selected' : ''}`} onClick={() => onSelect(item.id)}>
            <span className={`conversation-avatar ${item.kind === 'group' ? 'group-avatar' : ''}`}>{item.kind === 'group' ? <UsersRound size={22} strokeWidth={1.7} /> : conversationInitials(item, user.id)}</span>
            <span className="conversation-item-copy"><span className="conversation-item-top"><strong>{conversationTitle(item, user.id)}</strong><time>{formatConversationTime(last?.createdAt)}</time></span><span className="conversation-preview">{last ? `${last.senderId === user.id ? 'You: ' : ''}${last.body}` : item.kind === 'group' ? `${item.members.length} members · Say hello` : 'Start the conversation'}</span></span>
          </button>
        })}
      </nav>
      <div className="sidebar-account"><span className="account-avatar">{user.username[0]?.toUpperCase()}</span><span className="account-copy"><strong>{user.username}</strong><small>Signed in</small></span><button className="icon-button signout-button" onClick={onSignOut} title="Sign out" aria-label="Sign out"><LogOut size={18} /></button></div>
    </aside>
  )
}
