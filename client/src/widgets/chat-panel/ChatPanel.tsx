import { useHotkey } from '@tanstack/react-hotkeys'
import { ChevronDown, Copy, Forward, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { isMuted, type Chat } from '../../entities/chat/model'
import type { DeleteScope } from '../../entities/message/historySnapshot'
import { groupByDay } from '../../entities/message/messageDays'
import { MessageItem } from '../../entities/message/MessageItem'
import type { Message, PendingSend } from '../../entities/message/model'
import type { ReadingLocation } from '../../entities/message/readingLocation'
import type { User } from '../../entities/session/model'
import { MuteDialog } from '../../features/chat-preferences/MuteDialog'
import {
  DeleteConfirmation,
  type DeletionTarget,
} from '../../features/conversation/DeleteConfirmation'
import { MessageActionMenu } from '../../features/conversation/MessageActionMenu'
import type { useConversationFeatures } from '../../features/conversation/useConversationFeatures'
import { ForwardDialog } from '../../features/forward/ForwardDialog'
import { PinMessageDialog } from '../../features/message-pins/PinMessageDialog'
import { PinnedBar } from '../../features/message-pins/PinnedBar'
import { PinnedMessagesView } from '../../features/message-pins/PinnedMessagesView'
import type { MessagePins } from '../../features/message-pins/useMessagePins'
import { MessageComposer } from '../../features/message-send/MessageComposer'
import { ChatKind } from '../../shared/api/generated/socket-vocabulary'
import { formatDayLabel, formatMessageTime } from '../../shared/lib/time'
import type { MenuPoint } from '../../shared/ui/Menu'
import { ChatHeader } from './ChatHeader'
import { messageEntries } from './messageEntries'
import { sameMessageRun } from './messageGrouping'
import { useEnteringEntries } from './useEnteringEntries'
import { useMessageSelection } from './useMessageSelection'
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
  onRetry: (requestId: string) => void
  onBack: () => void
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
  readingLocation?: ReadingLocation
  locationRevision?: number
  onLocationChange?: (chatId: string, location: ReadingLocation) => void
  pins?: MessagePins
  forwardTargets?: Chat[]
  onForward?: (targetChatId: string, messages: Message[]) => void
  onMute?: (chatId: string, durationSeconds: number | null) => Promise<void>
  onUnmute?: (chatId: string) => Promise<void>
}

export function copyableText(
  messages: Message[],
  senderName: (senderId: string) => string,
): string {
  const ordered = [...messages].sort((left, right) =>
    BigInt(left.sequence) < BigInt(right.sequence) ? -1 : 1,
  )
  if (ordered.length === 1) return ordered[0].body
  return ordered
    .map(
      (message) =>
        `${senderName(message.senderId)}, [${new Date(message.createdAt).toLocaleDateString()} ${formatMessageTime(message.createdAt)}]\n${message.body}`,
    )
    .join('\n\n')
}

export function ChatPanel({
  chat,
  features,
  detached = false,
  currentUser,
  messages,
  pending,
  connection,
  onSend,
  onRetry,
  onBack,
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
  readingLocation,
  locationRevision = 0,
  onLocationChange,
  pins,
  forwardTargets,
  onForward,
  onMute,
  onUnmute,
}: Props) {
  const pendingForwardAuthors = useMemo(
    () => [
      ...new Set([
        ...pending.flatMap((send) => (send.forwardedFromUserId ? [send.forwardedFromUserId] : [])),
        ...(pins?.pins ?? []).flatMap(({ message }) => [
          message.senderId,
          ...(message.forwardedFromUserId ? [message.forwardedFromUserId] : []),
        ]),
      ]),
    ],
    [pending, pins?.pins],
  )
  const senderNames = useSenderNames(chat, messages, lookupUser, pendingForwardAuthors)
  const [pinnedView, setPinnedView] = useState(false)
  const [pinTarget, setPinTarget] = useState<Message | null>(null)
  const [forwarding, setForwarding] = useState<Message[] | null>(null)
  const [muting, setMuting] = useState(false)
  const [reply, setReply] = useState<Message | undefined>()
  const [edit, setEdit] = useState<Message | undefined>()
  const [confirm, setConfirm] = useState<DeletionTarget | null>(null)
  const [popup, setPopup] = useState<{
    messageId: string
    anchor: HTMLElement
    point?: MenuPoint
    keyboard: boolean
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const drafts = useRef(new Map<string, string>())
  const actionGeneration = useRef(0)
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
    setPopup(null)
    setPinnedView(false)
    setPinTarget(null)
    setForwarding(null)
    setMuting(false)
    actionGeneration.current += 1
    busyRef.current = false
    setBusy(false)
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

  useEffect(() => {
    const resolve = features?.resolveTarget
    if (!resolve) return
    let cancelled = false
    for (const target of [reply, edit]) {
      if (!target) continue
      void resolve(target.id)
        .then((current) => {
          if (cancelled) return
          if (!current) {
            setReply((previous) => (previous?.id === target.id ? undefined : previous))
            setEdit((previous) => (previous?.id === target.id ? undefined : previous))
            setAnnouncement('This message is no longer available.')
          } else {
            setReply((previous) => (previous?.id === target.id ? current : previous))
            setEdit((previous) => (previous?.id === target.id ? current : previous))
          }
        })
        .catch(() => {})
    }
    return () => {
      cancelled = true
    }
  }, [reply?.id, edit?.id, features?.revisionKey, features?.resolveTarget])

  const { scrollRef, highlight, handleScroll, stickToLatest } = useMessageViewport({
    chatId: chat?.id,
    userId: currentUser.id,
    messages,
    pendingState: pending.map((send) => send.status).join(),
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
    readingLocation,
    locationRevision,
    onLocationChange,
  })

  function sendFromComposer(chatId: string, body: string, replyToMessageId?: string) {
    const sent = onSend(chatId, body, replyToMessageId)
    if (sent) {
      stickToLatest()
      if (detached || hasNewer) onJumpToLatest()
    }
    return sent
  }

  const selection = useMessageSelection(scrollRef, messages, chat?.id)
  const composerRegion = useRef<HTMLDivElement>(null)

  useHotkey(
    'Escape',
    () => {
      if (document.querySelector('[role="dialog"]')) return
      if (pinnedView) setPinnedView(false)
      else if (selection.enabled) selection.clear()
      else if (reply || edit) {
        setReply(undefined)
        setEdit(undefined)
      } else onBack()
    },
    { enabled: Boolean(chat), ignoreInputs: false, stopPropagation: false, preventDefault: false },
  )

  useEffect(() => {
    const redirect = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return
      if (target.closest('input, textarea, button, [role="dialog"], .menu')) return
      if (selection.enabled) return
      composerRegion.current?.querySelector('textarea')?.focus()
    }
    window.addEventListener('keydown', redirect)
    return () => window.removeEventListener('keydown', redirect)
  }, [selection.enabled])

  function editLastMessage() {
    const last = [...messages]
      .reverse()
      .find((message) => message.senderId === currentUser.id && !message.deletedAt)
    if (last) setEdit(last)
  }
  useEffect(() => {
    if (selection.enabled) setPopup(null)
  }, [selection.enabled])
  const popupMessage = popup
    ? messages.find((message) => message.id === popup.messageId && !message.deletedAt)
    : undefined

  const callbacks = useRef({ onRetry, jump: features?.jumpToMessage })
  callbacks.current = { onRetry, jump: features?.jumpToMessage }
  const retry = useCallback((requestId: string) => callbacks.current.onRetry(requestId), [])
  const jumpToQuote = useCallback(
    (messageId: string, keyboard: boolean) => callbacks.current.jump?.(messageId, keyboard),
    [],
  )
  const openActions = useCallback(
    (target: Message, anchor: HTMLElement, keyboard: boolean, point?: MenuPoint) =>
      setPopup({ messageId: target.id, anchor, keyboard, point }),
    [],
  )
  const closePinnedView = useCallback(() => setPinnedView(false), [])
  const beginReply = useCallback((target: Message) => {
    setPopup(null)
    setEdit(undefined)
    setReply(target)
  }, [])
  function senderName(senderId: string) {
    return senderId === currentUser.id
      ? currentUser.username
      : (senderNames.get(senderId) ?? 'Member')
  }
  function forwardAuthor(senderId: string | null | undefined) {
    return senderId ? senderName(senderId) : undefined
  }
  async function copyMessages(targets: Message[]) {
    try {
      await navigator.clipboard.writeText(copyableText(targets, senderName))
      selection.clear()
      setAnnouncement(
        targets.length === 1 ? 'Message copied.' : `${targets.length} messages copied.`,
      )
    } catch {
      setAnnouncement('Could not copy. Select the message text to copy it.')
    }
  }
  function quoteAuthor(senderId: string | null | undefined) {
    return senderId === currentUser.id ? currentUser.username : senderNames.get(senderId ?? '')
  }
  function pendingTarget(send: PendingSend | undefined) {
    return send?.replyToMessageId
      ? messages.find((message) => message.id === send.replyToMessageId)
      : undefined
  }
  const entries = useMemo(
    () => (chat ? messageEntries(chat.id, recipient, messages, pending, hasNewer) : []),
    [chat?.id, recipient, messages, pending, hasNewer],
  )
  const days = useMemo(() => groupByDay(entries), [entries])
  const knownEmpty = !chat || chat.lastSequence === '0'
  const entering = useEnteringEntries(
    modeKey,
    entries.map((entry) => ({ key: entry.key, sequence: entry.message?.sequence })),
    { knownEmpty, latest: !hasNewer },
  )
  const fadedFor = useRef<string | undefined>()
  const hasEntries = entries.length > 0
  useLayoutEffect(() => {
    if (fadedFor.current === modeKey) return
    if (!hasEntries) {
      if (knownEmpty) fadedFor.current = modeKey
      return
    }
    fadedFor.current = modeKey
    const body = scrollRef.current
    if (!body || typeof body.animate !== 'function') return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    body.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' })
  }, [modeKey, hasEntries, knownEmpty, scrollRef])

  async function confirmDelete(scope: DeleteScope) {
    if (!confirm || !chat || busyRef.current) return
    busyRef.current = true
    const generation = ++actionGeneration.current
    setBusy(true)
    setActionError(null)
    try {
      if (confirm.kind === 'chat') await features?.deleteChat(scope)
      else if (confirm.kind === 'history') await features?.clearHistory(scope)
      else await features?.deleteMessages(confirm.messages, scope)
      if (active.current && generation === actionGeneration.current) {
        setConfirm(null)
        selection.clear()
        setAnnouncement(
          `${confirm.kind === 'chat' ? 'Chat deleted' : confirm.kind === 'history' ? 'History cleared' : 'Messages deleted'} for ${scope === 'SELF' ? 'you' : 'everyone'}.`,
        )
      }
    } catch (cause) {
      if (active.current && generation === actionGeneration.current)
        setActionError(cause instanceof Error ? cause.message : 'Could not delete')
    } finally {
      if (active.current && generation === actionGeneration.current) {
        busyRef.current = false
        setBusy(false)
      }
    }
  }

  if (!chat)
    return (
      <section className="chat-panel empty-panel">
        <p className="chat-hint">Select a chat to start messaging</p>
      </section>
    )

  return (
    <section className="chat-panel">
      <ChatHeader
        chat={chat}
        currentUser={currentUser}
        presence={features?.presence}
        onBack={onBack}
        onMembers={onMembers}
        onDelete={
          features
            ? () => {
                setConfirm({ kind: 'chat' })
                setActionError(null)
                setPopup(null)
              }
            : undefined
        }
        onClear={
          features
            ? () => {
                setConfirm({ kind: 'history' })
                setActionError(null)
                setPopup(null)
              }
            : undefined
        }
        muted={isMuted(chat)}
        onMute={onMute && !chat.id.startsWith('draft:') ? () => setMuting(true) : undefined}
        onUnmute={
          onUnmute && !chat.id.startsWith('draft:')
            ? () => void onUnmute(chat.id).catch(() => {})
            : undefined
        }
      />
      {pins && pins.pins.length > 0 && !pinnedView && (
        <PinnedBar
          key={chat.id}
          pins={pins.pins}
          total={pins.total}
          onJump={(messageId) => void features?.jumpToMessage(messageId, false)}
          onOpenList={() => setPinnedView(true)}
          onUnpin={(entry) => void pins.unpin(entry.message).catch(() => {})}
        />
      )}
      {pins && pinnedView && (
        <PinnedMessagesView
          pins={pins}
          currentUserId={currentUser.id}
          group={chat.kind === ChatKind.GROUP}
          senderName={(id) => senderName(id)}
          onBack={closePinnedView}
          onJump={(messageId) => {
            setPinnedView(false)
            void features?.jumpToMessage(messageId, false)
          }}
        />
      )}

      <div
        className="chat-body"
        hidden={pinnedView}
        ref={scrollRef}
        onScroll={handleScroll}
        role="region"
        aria-label="Messages"
        {...selection.handlers}
      >
        <div className="chat-body-inner">
          {loadingOlder && <span className="history-spinner" role="status" aria-label="Loading" />}
          {days.map((day) => (
            <section className="message-day" key={day.key}>
              <div className="message-day-label">
                <span>{formatDayLabel(day.timestamp)}</span>
              </div>
              {day.entries.map(({ entry: { key, message, send }, index }) => {
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
                    onRetry={retry}
                    read={Boolean(
                      message &&
                      BigInt(message.sequence) <=
                        BigInt(features?.summary.maxOtherReadSequence ?? '0'),
                    )}
                    onActions={features ? openActions : undefined}
                    onReply={features ? beginReply : undefined}
                    runStart={!sameMessageRun(entries[index - 1], entries[index], currentUser.id)}
                    runEnd={!sameMessageRun(entries[index], entries[index + 1], currentUser.id)}
                    selectionMode={selection.enabled}
                    selected={Boolean(message && selection.selected.has(message.id))}
                    forwardedFrom={forwardAuthor(
                      message?.forwardedFromUserId ?? send?.forwardedFromUserId,
                    )}
                    pinned={Boolean(message && pins?.pinnedIds.has(message.id))}
                    onQuote={features ? jumpToQuote : undefined}
                    quoteSender={quoteAuthor(
                      message?.replySenderId ?? pendingTarget(send)?.senderId,
                    )}
                    quoteText={pendingTarget(send)?.body}
                    quoteLoading={Boolean(
                      message?.replyToMessageId &&
                      features?.jumpLoading === message.replyToMessageId,
                    )}
                    highlighted={message?.id === highlight}
                    entering={entering.has(key)}
                  />
                )
              })}
            </section>
          ))}
          {entries.length === 0 && chat.lastSequence === '0' && (
            <p className="chat-hint chat-hint-center">No messages here yet</p>
          )}
          {loadingNewer && <span className="history-spinner" role="status" aria-label="Loading" />}
        </div>
      </div>

      {(detached || hasNewer || hasUnresolvedGap) && (
        <button className="fixed-latest" onClick={onJumpToLatest} aria-label="Back to latest">
          <ChevronDown size={24} />
        </button>
      )}
      <span className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </span>
      {selection.enabled && (
        <div className="message-selection-toolbar" aria-label="Selected messages">
          <button
            className="icon-button"
            aria-label="Cancel selection"
            onClick={() => selection.clear()}
          >
            <X size={21} />
          </button>
          <span role="status">
            {selection.selected.size} {selection.selected.size === 1 ? 'message' : 'messages'}
          </span>
          <button
            className="icon-button"
            aria-label="Copy selected messages"
            title="Copy"
            disabled={!selection.selected.size}
            onClick={() => void copyMessages([...selection.selected.values()])}
          >
            <Copy size={19} />
          </button>
          {onForward && (
            <button
              className="icon-button"
              aria-label="Forward selected messages"
              title="Forward"
              disabled={!selection.selected.size}
              onClick={() => setForwarding([...selection.selected.values()])}
            >
              <Forward size={20} />
            </button>
          )}
          <button
            className="button button-danger"
            disabled={!selection.selected.size}
            onClick={() => {
              setConfirm({ kind: 'messages', messages: [...selection.selected.values()] })
              setActionError(null)
            }}
          >
            <Trash2 size={17} />
            Delete
          </button>
        </div>
      )}
      <div
        className="chat-composer-region"
        ref={composerRegion}
        hidden={selection.enabled || pinnedView}
      >
        <MessageComposer
          key={modeKey}
          initialDraft={drafts.current.get(modeKey ?? '')}
          onDraftChange={(draft) => drafts.current.set(modeKey ?? '', draft)}
          onEditLast={features ? editLastMessage : undefined}
          chatId={chat.id}
          connected={connection === 'connected'}
          onSend={sendFromComposer}
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
      </div>
      {confirm && (
        <DeleteConfirmation
          key={confirm.kind}
          target={confirm}
          canDeleteEveryone={
            chat.kind === ChatKind.DIRECT ||
            chat.ownerId === currentUser.id ||
            (confirm.kind === 'messages' &&
              confirm.messages.every((message) => message.senderId === currentUser.id))
          }
          busy={busy}
          error={actionError}
          onCancel={() => setConfirm(null)}
          onConfirm={(scope) => void confirmDelete(scope)}
        />
      )}
      {popup && popupMessage && features && !selection.enabled && (
        <MessageActionMenu
          message={popupMessage}
          anchor={popup.anchor}
          point={popup.point}
          keyboard={popup.keyboard}
          mine={popupMessage.senderId === currentUser.id}
          readers={features.readers}
          onReply={() => beginReply(popupMessage)}
          onEdit={
            popupMessage.senderId === currentUser.id
              ? () => {
                  setReply(undefined)
                  setEdit(popupMessage)
                }
              : undefined
          }
          onDelete={() => {
            setConfirm({ kind: 'messages', messages: [popupMessage] })
            setActionError(null)
          }}
          onSelect={() => selection.start(popupMessage)}
          pinned={pins ? pins.pinnedIds.has(popupMessage.id) : undefined}
          onPin={pins ? () => setPinTarget(popupMessage) : undefined}
          onUnpin={pins ? () => void pins.unpin(popupMessage).catch(() => {}) : undefined}
          onForward={onForward ? () => setForwarding([popupMessage]) : undefined}
          onClose={() => setPopup(null)}
        />
      )}
      {pinTarget && pins && (
        <PinMessageDialog
          message={pinTarget}
          peerName={chat.kind === ChatKind.DIRECT ? senderName(recipient ?? '') : undefined}
          onCancel={() => setPinTarget(null)}
          onPin={(scope) => pins.pin(pinTarget, scope)}
        />
      )}
      {forwarding && onForward && (
        <ForwardDialog
          chats={forwardTargets ?? []}
          userId={currentUser.id}
          count={forwarding.length}
          onCancel={() => setForwarding(null)}
          onForward={(targetId) => {
            const messages = forwarding
            setForwarding(null)
            selection.clear()
            onForward(targetId, messages)
          }}
        />
      )}
      {muting && onMute && (
        <MuteDialog
          title={
            chat.kind === ChatKind.GROUP ? (chat.name ?? 'this group') : senderName(recipient ?? '')
          }
          onCancel={() => setMuting(false)}
          onMute={(seconds) => onMute(chat.id, seconds)}
        />
      )}
    </section>
  )
}
