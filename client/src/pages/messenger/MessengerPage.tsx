import { useState } from 'react'
import type { Session } from '../../entities/session/model'
import { CreateConversationDialog } from '../../features/conversation-create/CreateConversationDialog'
import { ConversationList } from '../../widgets/conversation-list/ConversationList'
import { ConversationPanel } from '../../widgets/conversation-panel/ConversationPanel'
import { useMessenger } from '../../app/useMessenger'

interface Props {
  session: Session
  onSignOut: () => void
}

export function MessengerPage({ session, onSignOut }: Props) {
  const messenger = useMessenger(session)
  const [creating, setCreating] = useState(false)
  const [mobileChat, setMobileChat] = useState(false)
  const selected = messenger.conversations.find((item) => item.id === messenger.selectedId)

  function select(id: string) { messenger.selectConversation(id); setMobileChat(true) }

  return <main className={`workspace ${mobileChat ? 'show-chat' : ''}`}>
    <ConversationList user={session.user} conversations={messenger.conversations} messages={messenger.messages} selectedId={messenger.selectedId} onSelect={select} onCreate={() => setCreating(true)} onSignOut={onSignOut} />
    <ConversationPanel conversation={selected} currentUser={session.user} messages={selected ? messenger.messages[selected.id] || [] : []} pending={messenger.pending} connection={messenger.connection} onSend={messenger.sendMessage} onRetry={(id) => void messenger.retryMessage(id)} onBack={() => setMobileChat(false)} onNew={() => setCreating(true)} />
    {messenger.error && <div className="toast" role="alert"><span>{messenger.error}</span><button onClick={messenger.clearError} aria-label="Dismiss">×</button></div>}
    {messenger.loading && <div className="loading-overlay" aria-label="Loading conversations"><div className="loading-spinner" /></div>}
    {creating && <CreateConversationDialog token={session.token} currentUserId={session.user.id} onClose={() => setCreating(false)} onDirect={async (id) => { await messenger.createDirect(id); setMobileChat(true) }} onGroup={async (name, ids) => { await messenger.createGroup(name, ids); setMobileChat(true) }} />}
  </main>
}
