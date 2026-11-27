import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useMessenger } from '../../app/useMessenger'
import { hasUnread } from '../../entities/chat/model'
import type { Message } from '../../entities/message/model'
import type { Session } from '../../entities/session/model'
import { SecurityDialog } from '../../features/account-security/SecurityDialog'
import { ChatActions, type ChatMenuTarget } from '../../features/chat-actions/ChatActions'
import { CreateChatDialog } from '../../features/chat-create/CreateChatDialog'
import { GroupMembersDialog } from '../../features/group-members/GroupMembersDialog'
import { useChatNotifications } from '../../features/notifications/useChatNotifications'
import { PresenceContext } from '../../features/presence/usePresence'
import { ChatKind } from '../../shared/api/generated/socket-vocabulary'
import { api } from '../../shared/api/http'
import { isNetworkOnline, subscribeNetwork } from '../../shared/lib/network'
import { isPageActive, subscribePageActivity } from '../../shared/lib/pageActivity'
import { ChatList } from '../../widgets/chat-list/ChatList'
import type { OpenChatMenu } from '../../widgets/chat-list/ChatRow'
import { ConnectionStatus } from '../../widgets/chat-list/ConnectionStatus'
import { FolderRail, type ChatFolder } from '../../widgets/chat-list/FolderRail'
import { ChatPanel } from '../../widgets/chat-panel/ChatPanel'
import { liveChatId, type ChatViewport } from './liveChat'

const NO_MESSAGES: Message[] = []

interface Props {
  session: Session
  onSignOut: () => void
  onSessionRevoked: () => void
}

export function MessengerPage({ session, onSignOut, onSessionRevoked }: Props) {
  const online = useSyncExternalStore(subscribeNetwork, isNetworkOnline)
  const pageActive = useSyncExternalStore(subscribePageActivity, isPageActive)
  const [viewport, setViewport] = useState<ChatViewport | null>(null)
  const messenger = useMessenger(session, onSessionRevoked)
  const [creating, setCreating] = useState<'direct' | 'group' | null>(null)
  const [managingMembers, setManagingMembers] = useState(false)
  const [managingSecurity, setManagingSecurity] = useState(false)
  const closeSecurity = useCallback(() => setManagingSecurity(false), [])
  const [folder, setFolder] = useState<ChatFolder>('all')
  const [chatMenu, setChatMenu] = useState<ChatMenuTarget | null>(null)
  const closeMembers = useCallback(() => setManagingMembers(false), [])
  const openChatMenu = useCallback<OpenChatMenu>(
    (chat, anchor, keyboard, point) => setChatMenu({ chat, anchor, keyboard, point }),
    [],
  )
  const searchUsers = useMemo(() => api.forSession(session).users, [session])
  const selected =
    messenger.chats.find((item) => item.id === messenger.selectedId) || messenger.draftChat
  const liveId = liveChatId({
    selectedId: selected?.id,
    viewport,
    hasNewer: messenger.hasNewerMessages,
    loadedMessages: selected ? (messenger.messages[selected.id]?.length ?? 0) : 0,
    pageActive,
  })
  const unreadChats = useMemo(() => {
    const counts = { all: 0, unread: 0, direct: 0, groups: 0 }
    for (const chat of messenger.chats) {
      if (!hasUnread(chat) || chat.id === liveId) continue
      counts.all += 1
      counts.unread += 1
      counts[chat.kind === ChatKind.GROUP ? 'groups' : 'direct'] += 1
    }
    return counts
  }, [messenger.chats, liveId])

  useEffect(() => {
    setManagingMembers(false)
  }, [selected?.id])

  useChatNotifications({
    chats: messenger.chats,
    userId: session.user.id,
    liveChatId: liveId,
    ready: !messenger.loading,
    onOpen: messenger.selectChat,
  })
  const pinnedOrder = useMemo(
    () => messenger.chats.filter((chat) => chat.pinnedRank != null).map((chat) => chat.id),
    [messenger.chats],
  )
  const reportError = useCallback(
    (cause: unknown) =>
      messenger.reportError(cause instanceof Error ? cause.message : String(cause)),
    [messenger.reportError],
  )

  useEffect(() => {
    document.title = unreadChats.all ? `(${unreadChats.all}) Messenger` : 'Messenger'
    return () => {
      document.title = 'Messenger'
    }
  }, [unreadChats.all])

  return (
    <PresenceContext.Provider value={messenger.presence}>
      <div className="messenger-shell">
        <main
          className={`workspace ${selected ? 'show-chat' : ''}`}
          onContextMenu={(event) => {
            if (!(event.target as HTMLElement).closest('input, textarea')) event.preventDefault()
          }}
        >
          <FolderRail
            user={session.user}
            folder={folder}
            unreadChats={unreadChats}
            onFolder={setFolder}
            onCreate={setCreating}
            onSecurity={() => setManagingSecurity(true)}
            onSignOut={onSignOut}
          />
          <ChatList
            user={session.user}
            chats={messenger.chats}
            folder={folder}
            loading={messenger.loading}
            messages={messenger.latestMessages}
            pending={messenger.pending}
            onReorderPinned={(order) => void messenger.reorderPinnedChats(order).catch(reportError)}
            selectedId={messenger.selectedId}
            liveChatId={liveId}
            onSelect={messenger.selectChat}
            onChatMenu={openChatMenu}
            onCreate={() => setCreating('direct')}
            onOpenUser={(user) => void messenger.createDirect(user)}
            searchUsers={searchUsers}
            onVisibleChats={messenger.watchSidebarPeers}
            hasMore={messenger.hasMoreChats}
            loadingMore={messenger.loadingMoreChats}
            onLoadMore={() => void messenger.loadMoreChats()}
          />
          <ChatPanel
            chat={selected}
            features={messenger.features}
            detached={messenger.detached}
            readingLocation={messenger.location}
            locationRevision={messenger.locationRevision}
            onLocationChange={messenger.rememberLocation}
            pins={messenger.pins}
            forwardTargets={messenger.chats}
            onForward={(targetId, messages) => {
              if (messenger.forwardMessages(targetId, messages)) messenger.selectChat(targetId)
            }}
            onMute={messenger.muteChat}
            onUnmute={messenger.unmuteChat}
            currentUser={session.user}
            messages={(selected && messenger.messages[selected.id]) || NO_MESSAGES}
            pending={messenger.pending}
            connection={messenger.connection}
            onSend={messenger.sendMessage}
            onRetry={(id) => void messenger.retryMessage(id)}
            onBack={() => {
              const chatId = selected?.id
              messenger.closeChat()
              requestAnimationFrame(() =>
                document.querySelector<HTMLElement>(`[data-chat-id="${chatId}"]`)?.focus(),
              )
            }}
            onMembers={() => setManagingMembers(true)}
            loadMembers={(chatId, after) => api.forSession(session).groupMembers(chatId, after)}
            lookupUser={messenger.lookupUser}
            hasOlder={messenger.hasOlderMessages}
            hasNewer={messenger.hasNewerMessages}
            hasUnresolvedGap={messenger.hasUnresolvedGap}
            loadingOlder={messenger.loadingOlder}
            loadingNewer={messenger.loadingNewer}
            onLoadOlder={() => selected && void messenger.loadOlder(selected.id)}
            onLoadNewer={() => selected && void messenger.loadNewer(selected.id)}
            onJumpToLatest={() => selected && void messenger.showLatest(selected.id)}
            jumpRevision={messenger.jumpRevision}
            onViewPositionChange={(atLatest) => {
              if (!selected) return
              const chatId = selected.id
              setViewport((current) =>
                current?.chatId === chatId && current.atLatest === atLatest
                  ? current
                  : { chatId, atLatest },
              )
              messenger.setAtLatestPosition(chatId, atLatest)
            }}
          />
          <ConnectionStatus
            connection={messenger.connection}
            networkOnline={online}
            nextRetryAt={messenger.reconnect.nextRetryAt}
            onRetry={messenger.retryNow}
          />
          {messenger.error && (
            <div className="toast" role="alert">
              <span>{messenger.error}</span>
              <button onClick={messenger.clearError} aria-label="Dismiss">
                ×
              </button>
            </div>
          )}
          {messenger.loading && (
            <div className="loading-bar" role="progressbar" aria-label="Loading chats" />
          )}
          {creating && (
            <CreateChatDialog
              session={session}
              currentUserId={session.user.id}
              initialMode={creating}
              onClose={() => setCreating(null)}
              onDirect={async (user) => {
                await messenger.createDirect(user)
              }}
              onGroup={async (name, ids) => {
                await messenger.createGroup(name, ids)
              }}
            />
          )}
          {chatMenu && (
            <ChatActions
              target={chatMenu}
              user={session.user}
              onDelete={messenger.deleteChatById}
              onClear={messenger.clearChatHistory}
              pinnedOrder={pinnedOrder}
              onPin={messenger.pinChat}
              onMovePinned={messenger.movePinnedChat}
              onMute={messenger.muteChat}
              onUnmute={messenger.unmuteChat}
              onMarkUnread={messenger.markChatUnread}
              onError={messenger.reportError}
              onClose={() => setChatMenu(null)}
            />
          )}
          {managingSecurity && (
            <SecurityDialog
              session={session}
              onClose={closeSecurity}
              onSignOut={() => {
                setManagingSecurity(false)
                onSignOut()
              }}
              onSessionInvalid={() => {
                setManagingSecurity(false)
                onSessionRevoked()
              }}
            />
          )}
          {managingMembers && selected?.kind === ChatKind.GROUP && (
            <GroupMembersDialog
              key={selected.id}
              chat={selected}
              session={session}
              onClose={closeMembers}
              onUpdated={messenger.updateChat}
            />
          )}
        </main>
      </div>
    </PresenceContext.Provider>
  )
}
