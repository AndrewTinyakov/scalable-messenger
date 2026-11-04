import { WifiOff } from 'lucide-react'
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { useMessenger } from '../../app/useMessenger'
import type { Session } from '../../entities/session/model'
import { CreateChatDialog } from '../../features/chat-create/CreateChatDialog'
import { GroupMembersDialog } from '../../features/group-members/GroupMembersDialog'
import { ChatKind } from '../../shared/api/generated/socket-vocabulary'
import { isNetworkOnline, subscribeNetwork } from '../../shared/lib/network'
import { ChatList } from '../../widgets/chat-list/ChatList'
import { ChatPanel } from '../../widgets/chat-panel/ChatPanel'

interface Props {
  session: Session
  onSignOut: () => void
  onSessionRevoked: () => void
}

export function MessengerPage({ session, onSignOut, onSessionRevoked }: Props) {
  const online = useSyncExternalStore(subscribeNetwork, isNetworkOnline)
  const messenger = useMessenger(session, onSessionRevoked)
  const [creating, setCreating] = useState(false)
  const [managingMembers, setManagingMembers] = useState(false)
  const closeMembers = useCallback(() => setManagingMembers(false), [])
  const selected =
    messenger.chats.find((item) => item.id === messenger.selectedId) || messenger.draftChat

  useEffect(() => {
    setManagingMembers(false)
  }, [selected?.id])

  function select(id: string) {
    messenger.selectChat(id)
  }

  return (
    <div className="messenger-shell">
      {(!online || messenger.connection !== 'connected') && (
        <div className="connection-notice" role="status">
          <WifiOff size={17} aria-hidden="true" />
          <div>
            <strong>{online ? 'Reconnecting…' : "You're offline"}</strong>
            <span>
              {online
                ? 'Your messages will update when the connection returns.'
                : "You can keep writing. We'll reconnect when you're back online."}
            </span>
          </div>
        </div>
      )}
      <main className={`workspace ${selected ? 'show-chat' : ''}`}>
        <ChatList
          user={session.user}
          chats={messenger.chats}
          messages={messenger.latestMessages}
          selectedId={messenger.selectedId}
          onSelect={select}
          onCreate={() => setCreating(true)}
          onRefresh={() => void messenger.refreshChats(true)}
          onSignOut={onSignOut}
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
          onNew={() => setCreating(true)}
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
        {messenger.error && (
          <div className="toast" role="alert">
            <span>{messenger.error}</span>
            <button onClick={messenger.clearError} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}
        {messenger.loading && (
          <div className="loading-overlay" aria-label="Loading chats">
            <div className="loading-spinner" />
          </div>
        )}
        {creating && (
          <CreateChatDialog
            session={session}
            currentUserId={session.user.id}
            onClose={() => setCreating(false)}
            onDirect={async (user) => {
              await messenger.createDirect(user)
            }}
            onGroup={async (name, ids) => {
              await messenger.createGroup(name, ids)
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
            presence={messenger.features.presence}
            onVisibleMembers={messenger.features.watchMembers}
          />
        )}
      </main>
    </div>
  )
}
