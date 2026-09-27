import { useState } from 'react'
import { LogOut, MessageCirclePlus, RefreshCw, Search, UsersRound } from 'lucide-react'
import { chatInitials, chatTitle, type Chat } from '../../entities/chat/model'
import type { Message } from '../../entities/message/model'
import type { User } from '../../entities/session/model'
import { formatChatTime } from '../../shared/lib/time'
import { Brand } from '../../shared/ui/Brand'

interface Props {
  user: User
  chats: Chat[]
  messages: Record<string, Message[]>
  selectedId: string | null
  onSelect: (id: string) => void
  onCreate: () => void
  onRefresh: () => void
  onSignOut: () => void
  hasMore: boolean
  loadingMore: boolean
  onLoadMore: () => void
}

export function ChatList({ user, chats, messages, selectedId, onSelect, onCreate, onRefresh, onSignOut, hasMore, loadingMore, onLoadMore }: Props) {
  const [filter, setFilter] = useState('')
  const visible = chats.filter((item) => chatTitle(item, user.id).toLowerCase().includes(filter.toLowerCase()))

  return (
    <aside className="sidebar">
      <div className="sidebar-header"><Brand compact /><div className="sidebar-actions"><button className="icon-button" onClick={onRefresh} aria-label="Refresh chats" title="Refresh chats"><RefreshCw size={18} strokeWidth={1.8} /></button><button className="icon-button sidebar-create" onClick={onCreate} aria-label="New chat" title="New chat"><MessageCirclePlus size={20} strokeWidth={1.8} /></button></div></div>
      <label className="sidebar-search"><Search size={18} strokeWidth={1.8} /><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search chats" aria-label="Search chats" /></label>
      <div className="chat-list-heading"><span>Chats</span><span>{chats.length}</span></div>
      <nav className="chat-list" aria-label="Chats">
        {visible.length === 0 && <div className="chat-list-empty">{chats.length ? 'No matching chats' : 'No chats yet'}</div>}
        {visible.map((item) => {
          const last = messages[item.id]?.at(-1)
          return <button key={item.id} className={`chat-item ${selectedId === item.id ? 'selected' : ''}`} onClick={() => onSelect(item.id)}>
            <span className={`chat-avatar ${item.kind === 'group' ? 'group-avatar' : ''}`}>{item.kind === 'group' ? <UsersRound size={22} strokeWidth={1.7} /> : chatInitials(item, user.id)}</span>
            <span className="chat-item-copy"><span className="chat-item-top"><strong>{chatTitle(item, user.id)}</strong><time>{formatChatTime(last?.createdAt)}</time></span><span className="chat-preview">{last ? `${last.senderId === user.id ? 'You: ' : ''}${last.body}` : item.lastSequence === '0' ? 'No messages yet' : 'Open to load messages'}</span></span>
          </button>
        })}
        {hasMore && <button className="chat-load-more" onClick={onLoadMore} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load more chats'}</button>}
      </nav>
      <div className="sidebar-account"><span className="account-avatar">{user.username[0]?.toUpperCase()}</span><span className="account-copy"><strong>{user.username}</strong><small>Signed in</small></span><button className="icon-button signout-button" onClick={onSignOut} title="Sign out" aria-label="Sign out"><LogOut size={18} /></button></div>
    </aside>
  )
}
