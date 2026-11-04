import { ArrowDown, MessageSquare } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Chat } from '../../entities/chat/model'
import { MessageItem } from '../../entities/message/MessageItem'
import type { Message, PendingSend } from '../../entities/message/model'
import type { User } from '../../entities/session/model'
import { DeleteConfirmation } from '../../features/conversation/DeleteConfirmation'
import { ReaderDialog } from '../../features/conversation/ReaderDialog'
import type { useConversationFeatures } from '../../features/conversation/useConversationFeatures'
import { MessageComposer } from '../../features/message-send/MessageComposer'
import { ChatKind } from '../../shared/api/generated/socket-vocabulary'
import { ChatHeader } from './ChatHeader'
import { messageEntries } from './messageEntries'
import { useMessageViewport } from './useMessageViewport'
import { useSenderNames } from './useSenderNames'

interface Props {
  chat: Chat | undefined
  currentUser: User
  messages: Message[]
  pending: PendingSend[]
  connection: 'connecting' | 'connected' | 'offline'
  onSend: (chatId: string, body: string, replyToMessageId?: string) => boolean
  features?: ReturnType<typeof useConversationFeatures>
  detached?: boolean
  onDeleteChat?: (chatId: string) => Promise<void>
  onRetry: (requestId: string) => void
  onBack: () => void
  onNew: () => void
  onMembers?: () => void
  lookupUser?: (id: string) => Promise<User>
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

export function ChatPanel({
  chat,
  features,
  detached = false,
  onDeleteChat,
  currentUser,
  messages,
  pending,
  connection,
  onSend,
  onRetry,
  onBack,
  onNew,
  onMembers,
  lookupUser,
  hasOlder,
  hasNewer,
  hasUnresolvedGap,
  loadingOlder,
  loadingNewer,
  onLoadOlder,
  onLoadNewer,
  onJumpToLatest,
  jumpRevision,
  onViewPositionChange,
}: Props) {
  const senderNames = useSenderNames(chat, messages, lookupUser)
  const [reply, setReply] = useState<Message | undefined>()
  const [edit, setEdit] = useState<Message | undefined>()
  const [confirm, setConfirm] = useState<Message | 'chat' | null>(null)
  const [readers, setReaders] = useState<Message | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const recipient =
    chat?.kind === ChatKind.DIRECT
      ? chat.members.find((member) => member.id !== currentUser.id)?.id
      : undefined
  const modeKey = recipient ? `user:${recipient}` : chat?.id
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  useEffect(() => {
    setReply(undefined)
    setEdit(undefined)
    setConfirm(null)
    setReaders(null)
    setActionError(null)
  }, [modeKey])
  useEffect(() => {
    if (reply) {
      const latest = messages.find((message) => message.id === reply.id)
      if (latest?.deletedAt) {
        setReply(undefined)
        setAnnouncement('The message you were replying to was deleted.')
      } else if (latest && latest !== reply) setReply(latest)
    }
    if (edit && messages.find((message) => message.id === edit.id)?.deletedAt) {
      setEdit(undefined)
      setAnnouncement('The message you were editing was deleted.')
    }
  }, [messages, reply, edit])

  const { scrollRef, highlight, rememberAnchor, handleScroll } = useMessageViewport({
    chatId: chat?.id,
    userId: currentUser.id,
    messages,
    pendingCount: pending.length,
    throughSequence: features?.summary.throughSequence,
    onRead: features?.readThrough,
    reveal: features?.reveal,
    jumpRevision,
    hasOlder,
    hasNewer,
    loadingOlder,
    loadingNewer,
    onLoadOlder,
    onLoadNewer,
    onViewPositionChange,
    announce: setAnnouncement,
  })

  async function confirmDelete() {
    if (!confirm || !chat || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setActionError(null)
    try {
      if (confirm === 'chat') await onDeleteChat?.(chat.id)
      else await features?.deleteMessage(confirm)
      if (active.current) {
        setConfirm(null)
        setAnnouncement(confirm === 'chat' ? 'Chat deleted for everyone.' : 'Message deleted.')
      }
    } catch (cause) {
      if (active.current)
        setActionError(cause instanceof Error ? cause.message : 'Could not delete')
    } finally {
      busyRef.current = false
      if (active.current) setBusy(false)
    }
  }

  if (!chat)
    return (
      <section className="chat-panel empty-panel">
        <MessageSquare size={38} strokeWidth={1.2} aria-hidden="true" />
        <h2>No chat selected</h2>
        <button className="button button-primary" onClick={onNew}>
          New chat
        </button>
      </section>
    )

  const entries = messageEntries(chat.id, recipient, messages, pending, hasNewer)

  return (
    <section className="chat-panel">
      <ChatHeader
        chat={chat}
        currentUser={currentUser}
        connection={connection}
        presence={features?.presence}
        onBack={onBack}
        onMembers={onMembers}
        onDelete={
          onDeleteChat
            ? () => {
                setConfirm('chat')
                setActionError(null)
              }
            : undefined
        }
      />

      <div
        className="chat-body"
        ref={scrollRef}
        onScroll={handleScroll}
        role="region"
        aria-label="Messages"
      >
        <div className="chat-body-inner">
          {hasOlder && (
            <button
              className="history-page-button"
              onClick={() => {
                rememberAnchor('older')
                onLoadOlder()
              }}
              disabled={loadingOlder}
            >
              {loadingOlder ? 'Loading…' : 'Load earlier messages'}
            </button>
          )}
          {entries.map(({ key, message, send }) => {
            const mine = Boolean(send || message?.senderId === currentUser.id)
            const sender = send
              ? currentUser.username
              : senderNames.get(message?.senderId || '') || 'Member'
            return (
              <MessageItem
                key={key}
                message={message}
                send={send}
                mine={mine}
                sender={sender}
                group={chat.kind === ChatKind.GROUP}
                connected={connection === 'connected'}
                onRetry={onRetry}
                read={Boolean(
                  message &&
                  BigInt(message.sequence) <= BigInt(features?.summary.maxOtherReadSequence ?? '0'),
                )}
                onReaders={features ? setReaders : undefined}
                onReply={
                  features
                    ? (target) => {
                        setEdit(undefined)
                        setReply(target)
                      }
                    : undefined
                }
                onEdit={
                  features
                    ? (target) => {
                        setReply(undefined)
                        setEdit(target)
                      }
                    : undefined
                }
                onDelete={
                  features
                    ? (target) => {
                        setConfirm(target)
                        setActionError(null)
                      }
                    : undefined
                }
                onQuote={features?.jumpToMessage}
                quoteSender={
                  message?.replySenderId === currentUser.id
                    ? currentUser.username
                    : senderNames.get(message?.replySenderId ?? '')
                }
                quoteLoading={Boolean(
                  message?.replyToMessageId && features?.jumpLoading === message.replyToMessageId,
                )}
                highlighted={message?.id === highlight}
              />
            )
          })}
          {(hasNewer || hasUnresolvedGap) && (
            <div className="history-newer-controls">
              {hasNewer && (
                <button
                  className="history-page-button"
                  onClick={() => {
                    rememberAnchor('newer')
                    onLoadNewer()
                  }}
                  disabled={loadingNewer}
                >
                  {loadingNewer ? 'Loading…' : 'Load newer messages'}
                </button>
              )}
              <button className="history-jump-button" onClick={onJumpToLatest}>
                {hasNewer ? 'Jump to latest' : 'Continue from here'}
              </button>
            </div>
          )}
        </div>
      </div>

      {(detached || hasNewer) && (
        <div className="fixed-latest-wrap">
          <button className="fixed-latest" onClick={onJumpToLatest}>
            <ArrowDown size={15} />
            Back to latest
          </button>
        </div>
      )}
      <span className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </span>
      <MessageComposer
        key={modeKey}
        chatId={chat.id}
        connected={connection === 'connected'}
        onSend={onSend}
        reply={
          reply
            ? {
                message: reply,
                sender:
                  reply.senderId === currentUser.id
                    ? currentUser.username
                    : (senderNames.get(reply.senderId) ?? 'Member'),
              }
            : undefined
        }
        edit={edit}
        onCancelMode={() => {
          setReply(undefined)
          setEdit(undefined)
        }}
        onSave={features?.editMessage}
      />
      {confirm && (
        <DeleteConfirmation
          target={confirm}
          busy={busy}
          error={actionError}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void confirmDelete()}
        />
      )}
      {readers && features && (
        <ReaderDialog
          key={readers.id}
          message={messages.find((message) => message.id === readers.id) ?? readers}
          load={features.readers}
          onClose={() => setReaders(null)}
        />
      )}
    </section>
  )
}
