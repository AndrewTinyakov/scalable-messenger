import { Check, Clock3, RotateCw, WifiOff } from "lucide-react";
import { useEffect, useRef } from "react";
import type { Conversation, Session } from "@messenger/contracts";
import type { ConversationState } from "../../../entities/message";
export function MessageTimeline({
  conversation,
  session,
  state,
  onRetry,
}: {
  conversation: Conversation;
  session: Session;
  state: ConversationState;
  onRetry: (requestId: string) => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth" });
  }, [state.messages.length, state.pending.length]);
  return (
    <div className="timeline">
      <div className="timeline-inner">
        <div className="thread-date">THE CONVERSATION</div>
        {state.messages.length === 0 && state.pending.length === 0 && (
          <div className="thread-empty">
            <span className="empty-spark">✳</span>
            <h2>A blank page, for now.</h2>
            <p>Say hello and get things started.</p>
          </div>
        )}
        {state.messages.map((message) => {
          const own = message.senderId === session.user.id;
          const sender = conversation.members.find(
            (member) => member.id === message.senderId,
          );
          return (
            <div
              className={`message-line ${own ? "own" : ""}`}
              key={message.id}
            >
              {!own && conversation.kind === "group" && (
                <span className="message-sender">
                  {sender?.name ?? "Member"}
                </span>
              )}
              <div className="message-bubble">{message.body}</div>
              <span className="message-meta">
                {new Date(message.createdAt).toLocaleTimeString(undefined, {
                  hour: "numeric",
                  minute: "2-digit",
                })}
                {own && (
                  <>
                    <Check size={13} /> Saved
                  </>
                )}
              </span>
            </div>
          );
        })}
        {state.pending.map((item) => (
          <div className="message-line own" key={item.requestId}>
            <div
              className={`message-bubble pending-bubble ${item.status === "rejected" || item.status === "retryable" ? "rejected-bubble" : ""}`}
            >
              {item.body}
            </div>
            <span className="message-meta">
              {item.status === "rejected" || item.status === "retryable" ? (
                <>
                  <WifiOff size={13} />
                  {item.reason ?? "Not sent"}{" "}
                  {item.status === "retryable" && (
                    <button
                      className="retry-link"
                      onClick={() => onRetry(item.requestId)}
                    >
                      <RotateCw size={12} /> Retry
                    </button>
                  )}
                </>
              ) : (
                <>
                  <Clock3 size={13} />
                  {item.status === "queued" ? "Queued" : "Sending"}
                </>
              )}
            </span>
          </div>
        ))}
        <div ref={end} />
      </div>
    </div>
  );
}
