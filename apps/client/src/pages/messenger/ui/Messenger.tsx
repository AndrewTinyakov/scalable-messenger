import { useState } from "react";
import type { Session } from "@messenger/contracts";
import { Chat } from "../../../widgets/chat";
import { NewConversation } from "../../../features/conversation-create";
import { Sidebar } from "../../../widgets/sidebar";
import { emptyConversation } from "../../../entities/message";
import { useMessenger } from "../../../features/messaging";
export function Messenger({
  session,
  onLogout,
}: {
  session: Session;
  onLogout: () => void;
}) {
  const messenger = useMessenger(session);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const conversation = messenger.conversations.find(
    (item) => item.id === selected,
  );
  async function logout() {
    await messenger.logout();
    onLogout();
  }
  async function create(
    kind: "direct" | "group",
    title: string,
    members: string[],
  ) {
    const result = await messenger.create(kind, title, members);
    setSelected(result.id);
    setCreating(false);
    void messenger.sync(result.id);
  }
  return (
    <div className={`app-shell ${selected ? "has-selection" : ""}`}>
      <Sidebar
        session={session}
        conversations={messenger.conversations}
        states={messenger.states}
        selected={selected}
        onSelect={(id) => {
          setSelected(id);
          void messenger.sync(id);
        }}
        onNew={() => setCreating(true)}
        onLogout={() => void logout()}
      />
      {conversation ? (
        <Chat
          conversation={conversation}
          session={session}
          state={messenger.states[conversation.id] ?? emptyConversation()}
          connection={messenger.connection}
          onSend={(body) => messenger.send(conversation.id, body)}
          onRetry={(requestId) => messenger.retry(conversation.id, requestId)}
          onBack={() => setSelected(null)}
        />
      ) : (
        <main className="welcome-pane">
          <div className="welcome-card">
            <span className="welcome-mark">✳</span>
            <p className="eyebrow">
              GOOD TO SEE YOU, {session.user.name.split(" ")[0]?.toUpperCase()}
            </p>
            <h1>
              Words find
              <br />
              their way here<span>.</span>
            </h1>
            <p>
              Choose a conversation to pick up where you left off, or start a
              new one.
            </p>
            <button className="text-action" onClick={() => setCreating(true)}>
              Start a conversation <span>↗</span>
            </button>
          </div>
          <span className="welcome-index">FOLIO / YOUR CONVERSATIONS</span>
        </main>
      )}
      {messenger.error && (
        <div className="toast" role="alert">
          {messenger.error}
          <button aria-label="Dismiss" onClick={() => messenger.setError("")}>
            ×
          </button>
        </div>
      )}
      {creating && (
        <NewConversation
          selfId={session.user.id}
          onClose={() => setCreating(false)}
          onCreate={create}
        />
      )}
    </div>
  );
}
