import { LogOut, MessageCircleMore, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { Conversation, Session } from "@messenger/contracts";
import type { ConversationState } from "../../../entities/message";
function initials(value: string) {
  return value
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}
function title(conversation: Conversation, session: Session) {
  return conversation.kind === "direct"
    ? (conversation.members.find((member) => member.id !== session.user.id)
        ?.name ?? conversation.title)
    : conversation.title;
}
function preview(conversation: Conversation, state?: ConversationState) {
  const pending = state?.pending.at(-1);
  if (pending) return pending.body;
  return (
    state?.messages.at(-1)?.body ??
    conversation.lastMessage?.body ??
    "Start the conversation"
  );
}
export function Sidebar({
  session,
  conversations,
  states,
  selected,
  onSelect,
  onNew,
  onLogout,
}: {
  session: Session;
  conversations: Conversation[];
  states: Record<string, ConversationState>;
  selected: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onLogout: () => void;
}) {
  const [query, setQuery] = useState("");
  const visible = useMemo(
    () =>
      conversations
        .filter((conversation) =>
          title(conversation, session)
            .toLowerCase()
            .includes(query.toLowerCase()),
        )
        .sort((a, b) =>
          (
            states[b.id]?.messages.at(-1)?.createdAt ??
            b.lastMessage?.createdAt ??
            ""
          ).localeCompare(
            states[a.id]?.messages.at(-1)?.createdAt ??
              a.lastMessage?.createdAt ??
              "",
          ),
        ),
    [conversations, query, session, states],
  );
  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <div className="brand">
          <span className="brand-mark">
            <MessageCircleMore size={19} />
          </span>
          <span>
            folio<span className="brand-period">.</span>
          </span>
        </div>
        <button
          className="icon-button new-button"
          title="New conversation"
          aria-label="New conversation"
          onClick={onNew}
        >
          <Plus size={20} />
        </button>
      </header>
      <div className="sidebar-intro">
        <p className="eyebrow">YOUR INBOX</p>
        <h2>
          Messages<span className="count-pill">{conversations.length}</span>
        </h2>
      </div>
      <label className="search-box">
        <Search size={17} />
        <span className="sr-only">Search conversations</span>
        <input
          placeholder="Search conversations"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="conversation-list">
        {visible.length ? (
          visible.map((conversation) => {
            const label = title(conversation, session);
            const last =
              states[conversation.id]?.messages.at(-1) ??
              conversation.lastMessage;
            return (
              <button
                key={conversation.id}
                onClick={() => onSelect(conversation.id)}
                className={`conversation-row ${selected === conversation.id ? "selected" : ""}`}
              >
                <span
                  className={`avatar ${conversation.kind === "group" ? "group-avatar" : ""}`}
                >
                  {initials(label || "Chat")}
                </span>
                <span className="conversation-info">
                  <span className="conversation-top">
                    <strong>{label || "Untitled group"}</strong>
                    <small>
                      {last &&
                        new Date(last.createdAt).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                        })}
                    </small>
                  </span>
                  <span className="conversation-preview">
                    {preview(conversation, states[conversation.id])}
                  </span>
                </span>
              </button>
            );
          })
        ) : (
          <div className="list-empty">
            {query
              ? "No matching conversations"
              : "No conversations yet. Start one with the plus button."}
          </div>
        )}
      </div>
      <footer className="account-bar">
        <span className="avatar account-avatar">
          {initials(session.user.name)}
        </span>
        <span className="account-info">
          <strong>{session.user.name}</strong>
          <small>@{session.user.username}</small>
        </span>
        <button
          className="icon-button"
          title="Sign out"
          aria-label="Sign out"
          onClick={onLogout}
        >
          <LogOut size={18} />
        </button>
      </footer>
    </aside>
  );
}
