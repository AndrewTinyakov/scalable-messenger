import { Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { chatPeer, chatTitle, type Chat } from '../../entities/chat/model'
import { ChatKind } from '../../shared/api/generated/socket-vocabulary'
import { Avatar } from '../../shared/ui/Avatar'
import { Dialog } from '../../shared/ui/Dialog'

interface Props {
  chats: Chat[]
  userId: string
  count: number
  onCancel(): void
  onForward(chatId: string): void
}

export function ForwardDialog({ chats, userId, count, onCancel, onForward }: Props) {
  const [query, setQuery] = useState('')
  const visible = useMemo(() => {
    const term = query.trim().toLowerCase()
    return chats.filter((chat) => !term || chatTitle(chat, userId).toLowerCase().includes(term))
  }, [chats, query, userId])
  return (
    <Dialog
      title={count === 1 ? 'Forward message' : `Forward ${count} messages`}
      onClose={onCancel}
    >
      <label className="sidebar-search forward-search">
        <Search size={18} />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && visible[0]) onForward(visible[0].id)
          }}
          placeholder="Search chats"
          aria-label="Search chats to forward to"
        />
      </label>
      <div className="forward-list" role="list">
        {visible.length === 0 && <p className="chat-list-empty">Nothing found</p>}
        {visible.map((chat) => {
          const title = chatTitle(chat, userId)
          return (
            <button
              key={chat.id}
              className="forward-target"
              role="listitem"
              onClick={() => onForward(chat.id)}
            >
              <Avatar
                seed={chatPeer(chat, userId) ?? chat.id}
                name={title}
                size={40}
                group={chat.kind === ChatKind.GROUP}
              />
              <span>
                <strong>{title}</strong>
                <small>
                  {chat.kind === ChatKind.GROUP
                    ? `${chat.memberCount} ${chat.memberCount === 1 ? 'member' : 'members'}`
                    : 'Personal chat'}
                </small>
              </span>
            </button>
          )
        })}
      </div>
    </Dialog>
  )
}
