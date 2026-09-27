import { useLayoutEffect, useRef } from 'react'
import { ArrowLeft, MessageSquare, UsersRound } from 'lucide-react'
import { chatInitials, chatTitle, type Chat } from '../../entities/chat/model'
import { MessageItem } from '../../entities/message/MessageItem'
import type { Message, PendingSend } from '../../entities/message/model'
import type { User } from '../../entities/session/model'
import { MessageComposer } from '../../features/message-send/MessageComposer'

interface Props {
  chat: Chat | undefined
  currentUser: User
  messages: Message[]
  pending: PendingSend[]
  connection: 'connecting' | 'connected' | 'offline'
  onSend: (chatId: string, body: string) => boolean
  onRetry: (requestId: string) => void
  onBack: () => void
  onNew: () => void
  hasOlder: boolean
  hasNewer: boolean
  hasUnresolvedGap: boolean
  loadingOlder: boolean
  loadingNewer: boolean
  onLoadOlder: () => void
  onLoadNewer: () => void
  onJumpToLatest: () => void
  jumpRevision: number
  onViewPositionChange: (atLatest: boolean) => void
}

export function ChatPanel({ chat, currentUser, messages, pending, connection, onSend, onRetry, onBack, onNew, hasOlder, hasNewer, hasUnresolvedGap, loadingOlder, loadingNewer, onLoadOlder, onLoadNewer, onJumpToLatest, jumpRevision, onViewPositionChange }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const anchorRef = useRef<{ id: string; top: number } | null>(null)
  const atBottomRef = useRef(true)
  const previousViewRef = useRef<{ chatId?: string; jumpRevision: number }>({ chatId: undefined, jumpRevision })
  const autoPageRef = useRef<{ older?: string; newer?: string }>({})

  function rememberAnchor(direction: 'older' | 'newer') {
    const scroller = scrollRef.current
    if (!scroller) return
    const bounds = scroller.getBoundingClientRect()
    const visible = [...scroller.querySelectorAll<HTMLElement>('[data-message-id]')]
      .filter((element) => element.getBoundingClientRect().bottom > bounds.top && element.getBoundingClientRect().top < bounds.bottom)
    const target = direction === 'older' ? visible[0] : visible.at(-1)
    if (target?.dataset.messageId) anchorRef.current = { id: target.dataset.messageId, top: target.getBoundingClientRect().top }
  }

  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    const previous = previousViewRef.current
    const switched = previous.chatId !== chat?.id || previous.jumpRevision !== jumpRevision
    previousViewRef.current = { chatId: chat?.id, jumpRevision }
    if (switched) {
      anchorRef.current = null
      scroller.scrollTop = scroller.scrollHeight
      atBottomRef.current = true
      onViewPositionChange(true)
      return
    }
    const anchor = anchorRef.current
    anchorRef.current = null
    const target = anchor && [...scroller.querySelectorAll<HTMLElement>('[data-message-id]')]
      .find((element) => element.dataset.messageId === anchor.id)
    if (anchor && target) scroller.scrollTop += target.getBoundingClientRect().top - anchor.top
    else if (atBottomRef.current && !hasNewer) scroller.scrollTop = scroller.scrollHeight
  }, [chat?.id, messages, pending.length, hasNewer, jumpRevision])

  function handleScroll() {
    const scroller = scrollRef.current
    if (!scroller) return
    const distanceToBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
    atBottomRef.current = distanceToBottom < 48
    onViewPositionChange(atBottomRef.current && !hasNewer)
    const first = messages[0]?.sequence
    const last = messages.at(-1)?.sequence
    if (scroller.scrollTop < 120 && hasOlder && !loadingOlder && first && autoPageRef.current.older !== first) {
      autoPageRef.current.older = first
      rememberAnchor('older')
      onLoadOlder()
    } else if (distanceToBottom < 120 && hasNewer && !loadingNewer && last && autoPageRef.current.newer !== last) {
      autoPageRef.current.newer = last
      rememberAnchor('newer')
      onLoadNewer()
    }
  }

  if (!chat) return <section className="chat-panel empty-panel"><MessageSquare size={38} strokeWidth={1.2} aria-hidden="true" /><h2>No chat selected</h2><button className="button button-primary" onClick={onNew}>New chat</button></section>

  const senderNames = new Map(chat.members.map((member) => [member.id, member.username]))
  const unsaved = hasNewer ? [] : pending.filter((send) => send.chatId === chat.id && !messages.some((message) => message.id === send.messageId))
  const entries = [
    ...messages.map((message) => ({ key: message.id, message, send: undefined as PendingSend | undefined })),
    ...unsaved.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((send) => ({ key: send.requestId, message: undefined as Message | undefined, send })),
  ]

  return <section className="chat-panel">
    <header className="chat-header">
      <button className="icon-button mobile-back" onClick={onBack} aria-label="Back to chats"><ArrowLeft size={20} /></button>
      <span className={`chat-header-avatar ${chat.kind === 'group' ? 'group-avatar' : ''}`}>{chat.kind === 'group' ? <UsersRound size={22} /> : chatInitials(chat, currentUser.id)}</span>
      <div className="chat-header-info"><h2>{chatTitle(chat, currentUser.id)}</h2><p>{chat.kind === 'group' ? `${chat.memberCount} members` : 'Direct chat'}</p></div>
      <span className={`connection-pill ${connection}`}><span />{connection === 'connected' ? 'Live' : connection === 'connecting' ? 'Connecting' : 'Offline'}</span>
    </header>

    <div className="chat-body" ref={scrollRef} onScroll={handleScroll} role="log" aria-label="Messages" aria-live="polite">
      <div className="chat-body-inner">
        {hasOlder && <button className="history-page-button" onClick={() => { rememberAnchor('older'); onLoadOlder() }} disabled={loadingOlder}>{loadingOlder ? 'Loading…' : 'Load earlier messages'}</button>}
        {entries.map(({ key, message, send }) => {
          const mine = Boolean(send || message?.senderId === currentUser.id)
          const sender = send ? currentUser.username : senderNames.get(message?.senderId || '') || 'Member'
          return <MessageItem key={key} message={message} send={send} mine={mine} sender={sender} group={chat.kind === 'group'} connected={connection === 'connected'} onRetry={onRetry} />
        })}
        {(hasNewer || hasUnresolvedGap) && <div className="history-newer-controls">{hasNewer && <button className="history-page-button" onClick={() => { rememberAnchor('newer'); onLoadNewer() }} disabled={loadingNewer}>{loadingNewer ? 'Loading…' : 'Load newer messages'}</button>}<button className="history-jump-button" onClick={onJumpToLatest}>{hasNewer ? 'Jump to latest' : 'Continue from here'}</button></div>}
      </div>
    </div>

    <MessageComposer chatId={chat.id} connected={connection === 'connected'} onSend={onSend} />
  </section>
}
