import { Send } from "lucide-react";
import { useState, type FormEvent } from "react";
export function Composer({ onSend }: { onSend: (body: string) => boolean }) {
  const [draft, setDraft] = useState("");
  function submit(event: FormEvent) {
    event.preventDefault();
    if (onSend(draft)) setDraft("");
  }
  return (
    <form className="composer" onSubmit={submit}>
      <div className="composer-field">
        <textarea
          aria-label="Message"
          placeholder="Write a message…"
          value={draft}
          maxLength={4000}
          rows={1}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <button
          className="send-button"
          aria-label="Send message"
          disabled={!draft.trim()}
        >
          <Send size={18} />
        </button>
      </div>
      <small>Enter to send · Shift + Enter for a new line</small>
    </form>
  );
}
