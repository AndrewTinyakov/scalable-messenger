import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useMessenger } from '../../app/useMessenger'
import type { Session } from '../../entities/session/model'
import { ChatActions, type ChatMenuTarget } from '../../features/chat-actions/ChatActions'
import { CreateChatDialog } from '../../features/chat-create/CreateChatDialog'
import { GroupMembersDialog } from '../../features/group-members/GroupMembersDialog'
import { ChatKind } from '../../shared/api/generated/socket-vocabulary'
import { api } from '../../shared/api/http'
import { isNetworkOnline, subscribeNetwork } from '../../shared/lib/network'
import { ChatList } from '../../widgets/chat-list/ChatList'
import type { OpenChatMenu } from '../../widgets/chat-list/ChatRow'
import { ConnectionStatus } from '../../widgets/chat-list/ConnectionStatus'
import { FolderRail, type ChatFolder } from '../../widgets/chat-list/FolderRail'
import { ChatPanel } from '../../widgets/chat-panel/ChatPanel'

interface Props {
  session: Session
  onSignOut: () => void
  onSessionRevoked: () => void
}

export function MessengerPage({ session, onSignOut, onSessionRevoked }: Props) {
  const online = useSyncExternalStore(subscribeNetwork, isNetworkOnline)
  const messenger = useMessenger(session, onSessionRevoked)
  const [creating, setCreating] = useState<'direct' | 'group' | null>(null)
  const [managingMembers, setManagingMembers] = useState(false)
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
  const unreadChats = useMemo(() => {
    const counts = { all: 0, unread: 0, direct: 0, groups: 0 }
    for (const chat of messenger.chats) {
      if (!chat.unreadCount) continue
      counts.all += 1
      counts.unread += 1
      counts[chat.kind === ChatKind.GROUP ? 'groups' : 'direct'] += 1
    }
    return counts
  }, [messenger.chats])

  useEffect(() => {
    setManagingMembers(false)
  }, [selected?.id])

  useEffect(() => {
    document.title = unreadChats.all ? `(${unreadChats.all}) Messenger` : 'Messenger'
    return () => {
      document.title = 'Messenger'
    }
  }, [unreadChats.all])

  return (
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
          onSignOut={onSignOut}
        />
        <ChatList
          user={session.user}
          chats={messenger.chats}
          folder={folder}
          loading={messenger.loading}
          messages={messenger.latestMessages}
          selectedId={messenger.selectedId}
          presence={messenger.sidebarPresence}
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
          currentUser={session.user}
          messages={selected ? messenger.messages[selected.id] || [] : []}
          pending={messenger.pending}
          connection={messenger.connection}
          onSend={messenger.sendMessage}
          onRetry={(id) => void messenger.retryMessage(id)}
          onBack={messenger.closeChat}
          onMembers={() => setManagingMembers(true)}
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
          onViewPositionChange={(atLatest) =>
            selected && messenger.setAtLatestPosition(selected.id, atLatest)
          }
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
            onClose={() => setChatMenu(null)}
          />
        )}
        {managingMembers && selected?.kind === ChatKind.GROUP && (
          <GroupMembersDialog
            key={selected.id}
            chat={selected}
            session={session}
            onClose={closeMembers}
            onUpdated={messenger.updateChat}
            presence={messenger.features.presence}
            onVisibleMembers={messenger.features.watchMembers}
          />
        )}
      </main>
    </div>
  )
}
