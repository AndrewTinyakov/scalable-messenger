import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Search, X } from "lucide-react";
import type { User } from "@messenger/contracts";
import { api } from "../../../shared/api";
export function NewConversation({
  selfId,
  onClose,
  onCreate,
}: {
  selfId: string;
  onClose: () => void;
  onCreate: (
    kind: "direct" | "group",
    title: string,
    members: string[],
  ) => Promise<void>;
}) {
  const [kind, setKind] = useState<"direct" | "group">("direct");
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<User[]>([]);
  const [chosen, setChosen] = useState<User[]>([]);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    searchRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((item) => item.getClientRects().length > 0);
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!dialogRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, []);
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      void api
        .users(query)
        .then((found) => {
          if (active) setUsers(found.filter((user) => user.id !== selfId));
        })
        .catch(() => {
          if (active) setUsers([]);
        });
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, selfId]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!chosen.length || (kind === "group" && !title.trim())) return;
    setBusy(true);
    setError("");
    try {
      await onCreate(
        kind,
        title.trim(),
        chosen.map((user) => user.id),
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not create conversation",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="modal-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="new-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-heading"
      >
        <header>
          <div>
            <p className="eyebrow">A NEW CONNECTION</p>
            <h2 id="new-heading">Start something.</h2>
          </div>
          <button className="icon-button" aria-label="Close" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        <form onSubmit={submit}>
          <div className="kind-switch">
            <button
              type="button"
              className={kind === "direct" ? "active" : ""}
              onClick={() => {
                setKind("direct");
                setChosen(chosen.slice(0, 1));
              }}
            >
              One to one
            </button>
            <button
              type="button"
              className={kind === "group" ? "active" : ""}
              onClick={() => setKind("group")}
            >
              Group
            </button>
          </div>
          {kind === "group" && (
            <label className="dialog-label">
              Group name
              <input
                required
                maxLength={80}
                placeholder="e.g. Weekend plans"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
          )}
          <label className="dialog-label">
            Find people
            <span className="picker-search">
              <Search size={16} />
              <input
                ref={searchRef}
                placeholder="Search by name or username"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </span>
          </label>
          {chosen.length > 0 && (
            <div className="chosen-list">
              {chosen.map((user) => (
                <button
                  type="button"
                  key={user.id}
                  onClick={() =>
                    setChosen(chosen.filter((item) => item.id !== user.id))
                  }
                >
                  {user.name}
                  <X size={13} />
                </button>
              ))}
            </div>
          )}
          <div className="user-results">
            {users
              .filter((user) => !chosen.some((item) => item.id === user.id))
              .map((user) => (
                <button
                  type="button"
                  key={user.id}
                  onClick={() => {
                    setChosen(kind === "direct" ? [user] : [...chosen, user]);
                    setQuery("");
                  }}
                >
                  <span className="avatar">
                    {user.name.slice(0, 2).toUpperCase()}
                  </span>
                  <span>
                    <strong>{user.name}</strong>
                    <small>@{user.username}</small>
                  </span>
                </button>
              ))}
            {!users.length && <p>No people found.</p>}
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button
            className="primary-button"
            disabled={
              busy || !chosen.length || (kind === "group" && !title.trim())
            }
          >
            Create conversation
            <ArrowRight size={18} />
          </button>
        </form>
      </section>
    </div>
  );
}
