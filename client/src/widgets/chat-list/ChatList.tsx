import { Pencil, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { chatPeer, chatTitle, hasUnread, type Chat } from '../../entities/chat/model'
import type { Message } from '../../entities/message/model'
import type { User } from '../../entities/session/model'
import { ChatKind } from '../../shared/api/generated/socket-vocabulary'
import { Avatar } from '../../shared/ui/Avatar'
import { ChatRow, type OpenChatMenu } from './ChatRow'
import type { ChatFolder } from './FolderRail'

const MAX_PEOPLE_RESULTS = 8

interface Props {
  user: User
  chats: Chat[]
  folder: ChatFolder
  loading: boolean
  messages: Record<string, Message[]>
  selectedId: string | null
  presence: Record<string, 'online' | 'offline' | 'unknown'>
  onSelect(id: string): void
  onChatMenu: OpenChatMenu
  onCreate(): void
  onOpenUser(user: User): void
  searchUsers(query: string): Promise<User[]>
  onVisibleChats(chatIds: string[]): void
  hasMore: boolean
  loadingMore: boolean
  onLoadMore(): void
}

function inFolder(chat: Chat, folder: ChatFolder): boolean {
  if (folder === 'unread') return hasUnread(chat)
  if (folder === 'direct') return chat.kind === ChatKind.DIRECT
  if (folder === 'groups') return chat.kind === ChatKind.GROUP
  return true
}

function usePeopleSearch(query: string, search: Props['searchUsers']) {
  const [people, setPeople] = useState<User[]>([])
  useEffect(() => {
    let active = true
    setPeople([])
    if (!query) return
    const timer = window.setTimeout(() => {
      search(query)
        .then((users) => {
          if (active) setPeople(users)
        })
        .catch(() => {})
    }, 220)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [query, search])
  return people
}

function useVisibleChats(
  list: React.RefObject<HTMLElement>,
  ids: string,
  report: (ids: string[]) => void,
) {
  const reportRef = useRef(report)
  reportRef.current = report
  useEffect(() => {
    const root = list.current
    if (!root || typeof IntersectionObserver === 'undefined') return
    const visible = new Set<string>()
    const observer = new IntersectionObserver(
      (records) => {
        for (const record of records) {
          const id = (record.target as HTMLElement).dataset.chatId
          if (!id) continue
          if (record.isIntersecting) visible.add(id)
          else visible.delete(id)
        }
        reportRef.current([...visible])
      },
      { root },
    )
    root.querySelectorAll('[data-chat-id]').forEach((row) => observer.observe(row))
    return () => observer.disconnect()
  }, [ids, list])
}

function useEndReached(enabled: boolean, onReached: () => void) {
  const ref = useRef<HTMLButtonElement>(null)
  const reached = useRef(onReached)
  reached.current = onReached
  useEffect(() => {
    const target = ref.current
    if (!target || !enabled || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      ([record]) => {
        if (record?.isIntersecting) reached.current()
      },
      { rootMargin: '480px' },
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [enabled])
  return ref
}

export function ChatList({
  user,
  chats,
  folder,
  loading,
  messages,
  selectedId,
  presence,
  onSelect,
  onChatMenu,
  onCreate,
  onOpenUser,
  searchUsers,
  onVisibleChats,
  hasMore,
  loadingMore,
  onLoadMore,
}: Props) {
  const [filter, setFilter] = useState('')
  const listRef = useRef<HTMLElement>(null)
  const query = filter.trim().toLowerCase()
  const visible = useMemo(
    () =>
      chats.filter((chat) =>
        query ? chatTitle(chat, user.id).toLowerCase().includes(query) : inFolder(chat, folder),
      ),
    [chats, folder, query, user.id],
  )
  const people = usePeopleSearch(query, searchUsers)
    .filter(
      (person) =>
        person.id !== user.id && !visible.some((chat) => chatPeer(chat, user.id) === person.id),
    )
    .slice(0, MAX_PEOPLE_RESULTS)
  const visibleIds = useMemo(() => visible.map((chat) => chat.id).join(), [visible])
  useVisibleChats(listRef, visibleIds, onVisibleChats)
  const loadMoreRef = useEndReached(hasMore && !loadingMore, onLoadMore)

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <label className="sidebar-search">
          <Search size={18} />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setFilter('')
            }}
            placeholder="Search"
            aria-label="Search chats and people"
          />
          {filter && (
            <button
              type="button"
              className="sidebar-search-clear"
              onClick={() => setFilter('')}
              aria-label="Clear search"
            >
              <X size={15} />
            </button>
          )}
        </label>
      </div>
      <nav className="chat-list" aria-label="Chats" ref={listRef}>
        {loading &&
          chats.length === 0 &&
          [0, 1, 2, 3, 4, 5, 6].map((index) => (
            <div className="chat-skeleton" key={index} aria-hidden="true">
              <span />
              <span>
                <i />
                <i />
              </span>
            </div>
          ))}
        {!loading && visible.length === 0 && people.length === 0 && (
          <div className="chat-list-empty">
            {query ? 'Nothing found' : folder === 'unread' ? 'All caught up' : 'No chats here yet'}
          </div>
        )}
        {visible.map((chat) => {
          const peer = chatPeer(chat, user.id)
          return (
            <ChatRow
              key={chat.id}
              chat={chat}
              userId={user.id}
              selected={selectedId === chat.id}
              online={peer !== undefined && presence[peer] === 'online'}
              loaded={messages[chat.id]?.at(-1)}
              onSelect={onSelect}
              onMenu={onChatMenu}
            />
          )
        })}
        {people.length > 0 && <div className="chat-list-heading">People</div>}
        {people.map((person) => (
          <button key={person.id} className="chat-item" onClick={() => onOpenUser(person)}>
            <Avatar seed={person.id} name={person.username} size={54} />
            <span className="chat-item-copy">
              <span className="chat-item-top">
                <strong>{person.username}</strong>
              </span>
              <span className="chat-item-bottom">
                <span className="chat-preview">Start a conversation</span>
              </span>
            </span>
          </button>
        ))}
        {hasMore && !query && (
          <button
            ref={loadMoreRef}
            className="chat-load-more"
            onClick={onLoadMore}
            disabled={loadingMore}
          >
            {loadingMore ? 'Loading…' : 'Load more chats'}
          </button>
        )}
      </nav>
      {!query && (
        <button className="compose-button" onClick={onCreate} aria-label="New chat">
          <Pencil size={22} />
        </button>
      )}
    </aside>
  )
}
