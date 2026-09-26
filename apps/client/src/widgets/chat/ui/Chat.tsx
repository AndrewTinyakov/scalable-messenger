import { ArrowLeft, Users } from "lucide-react";
import type { Conversation, Session } from "@messenger/contracts";
import type { ConversationState } from "../../../entities/message";
import { MessageTimeline } from "./MessageTimeline";
import { Composer } from "./Composer";
export function Chat({
  conversation,
  session,
  state,
  connection,
  onSend,
  onRetry,
  onBack,
}: {
  conversation: Conversation;
  session: Session;
  state: ConversationState;
  connection: string;
  onSend: (body: string) => boolean;
  onRetry: (requestId: string) => void;
  onBack: () => void;
}) {
  const other = conversation.members.find(
    (member) => member.id !== session.user.id,
  );
  const title =
    conversation.kind === "direct"
      ? (other?.name ?? conversation.title)
      : conversation.title;
  return (
    <section className="chat">
      <header className="chat-header">
        <button
          className="icon-button back-button"
          aria-label="Back to conversations"
          onClick={onBack}
        >
          <ArrowLeft size={20} />
        </button>
        <span
          className={`avatar header-avatar ${conversation.kind === "group" ? "group-avatar" : ""}`}
        >
          {(title || "?").slice(0, 2).toUpperCase()}
        </span>
        <span className="chat-heading">
          <strong>{title || "Untitled group"}</strong>
          <small>
            {conversation.kind === "group" ? (
              <>
                <Users size={12} />
                {conversation.members.length} members
              </>
            ) : (
              `@${other?.username ?? "member"}`
            )}
          </small>
        </span>
        <span
          className={`connection ${connection === "live" ? "is-live" : ""}`}
        >
          <span className="status-dot" />
          {connection === "live"
            ? "Connected"
            : connection === "connecting"
              ? "Connecting"
              : "Reconnecting"}
        </span>
      </header>
      <MessageTimeline
        key={conversation.id}
        conversation={conversation}
        session={session}
        state={state}
        onRetry={onRetry}
      />
      <Composer key={conversation.id} onSend={onSend} />
    </section>
  );
}
