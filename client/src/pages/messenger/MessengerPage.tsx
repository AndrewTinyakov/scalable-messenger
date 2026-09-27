import { useState } from 'react'
import type { Session } from '../../entities/session/model'
import { CreateChatDialog } from '../../features/chat-create/CreateChatDialog'
import { ChatList } from '../../widgets/chat-list/ChatList'
import { ChatPanel } from '../../widgets/chat-panel/ChatPanel'
import { useMessenger } from '../../app/useMessenger'

interface Props {
  session: Session
  onSignOut: () => void
  onSessionRevoked: () => void
}

export function MessengerPage({ session, onSignOut, onSessionRevoked }: Props) {
  const messenger = useMessenger(session, onSessionRevoked)
  const [creating, setCreating] = useState(false)
  const [mobileChat, setMobileChat] = useState(false)
  const selected = messenger.chats.find((item) => item.id === messenger.selectedId) || messenger.draftChat

  function select(id: string) { messenger.selectChat(id); setMobileChat(true) }

  return <main className={`workspace ${mobileChat ? 'show-chat' : ''}`}>
    <ChatList user={session.user} chats={messenger.chats} messages={messenger.messages} selectedId={messenger.selectedId} onSelect={select} onCreate={() => setCreating(true)} onRefresh={() => void messenger.refreshChats(true)} onSignOut={onSignOut} hasMore={messenger.hasMoreChats} loadingMore={messenger.loadingMoreChats} onLoadMore={() => void messenger.loadMoreChats()} />
    <ChatPanel chat={selected} currentUser={session.user} messages={selected ? messenger.messages[selected.id] || [] : []} pending={messenger.pending} connection={messenger.connection} onSend={messenger.sendMessage} onRetry={(id) => void messenger.retryMessage(id)} onBack={() => setMobileChat(false)} onNew={() => setCreating(true)} hasOlder={messenger.hasOlderMessages} hasNewer={messenger.hasNewerMessages} hasUnresolvedGap={messenger.hasUnresolvedGap} loadingOlder={messenger.loadingOlder} loadingNewer={messenger.loadingNewer} onLoadOlder={() => selected && void messenger.loadOlder(selected.id)} onLoadNewer={() => selected && void messenger.loadNewer(selected.id)} onJumpToLatest={() => selected && void messenger.showLatest(selected.id)} jumpRevision={messenger.jumpRevision} onViewPositionChange={(atLatest) => selected && messenger.setAtLatestPosition(selected.id, atLatest)} />
    {messenger.error && <div className="toast" role="alert"><span>{messenger.error}</span><button onClick={messenger.clearError} aria-label="Dismiss">×</button></div>}
    {messenger.loading && <div className="loading-overlay" aria-label="Loading chats"><div className="loading-spinner" /></div>}
    {creating && <CreateChatDialog token={session.token} currentUserId={session.user.id} onClose={() => setCreating(false)} onDirect={async (user) => { await messenger.createDirect(user); setMobileChat(true) }} onGroup={async (name, ids) => { await messenger.createGroup(name, ids); setMobileChat(true) }} />}
  </main>
}
