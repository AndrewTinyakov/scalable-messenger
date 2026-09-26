import { useState, type FormEvent } from "react";
import { ArrowRight, MessageCircleMore } from "lucide-react";
import { api } from "../../../shared/api";
import { deviceId } from "../../../shared/lib/device";
import type { Session } from "@messenger/contracts";

export function Auth({ onSession }: { onSession: (session: Session) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onSession(
        mode === "login"
          ? await api.login(username, password, deviceId())
          : await api.register(username, name, password, deviceId()),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sign in");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-page">
      <div className="auth-art" aria-hidden="true">
        <span className="art-kicker">A little more human</span>
        <div className="art-quote">
          Every good
          <br />
          conversation
          <br />
          <em>has a place.</em>
        </div>
        <div className="art-orbit orbit-one" />
        <div className="art-orbit orbit-two" />
        <div className="art-foot">FOLIO / 001</div>
      </div>
      <section className="auth-panel">
        <div className="brand">
          <span className="brand-mark">
            <MessageCircleMore size={20} />
          </span>
          <span>
            folio<span className="brand-period">.</span>
          </span>
        </div>
        <div className="auth-content">
          <p className="eyebrow">YOUR SPACE TO CONNECT</p>
          <h1>
            {mode === "login" ? "Welcome back." : "Start a conversation."}
          </h1>
          <p className="subtle">
            {mode === "login"
              ? "Pick up where you left off."
              : "A quieter place to stay in touch."}
          </p>
          <form onSubmit={submit} className="auth-form">
            {mode === "register" && (
              <label>
                Display name
                <input
                  autoComplete="name"
                  required
                  maxLength={60}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="What should we call you?"
                />
              </label>
            )}
            <label>
              Username
              <input
                autoComplete="username"
                required
                minLength={3}
                maxLength={32}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="Your username"
              />
            </label>
            <label>
              Password
              <input
                type="password"
                autoComplete={
                  mode === "login" ? "current-password" : "new-password"
                }
                required
                minLength={8}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Your password"
              />
            </label>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <button className="primary-button" disabled={busy}>
              {busy
                ? "One moment…"
                : mode === "login"
                  ? "Sign in"
                  : "Create account"}
              <ArrowRight size={18} />
            </button>
          </form>
          <p className="switch-auth">
            {mode === "login" ? "New to Folio?" : "Already have an account?"}{" "}
            <button
              onClick={() => {
                setError("");
                setMode(mode === "login" ? "register" : "login");
              }}
            >
              {mode === "login" ? "Create an account" : "Sign in"}
            </button>
          </p>
        </div>
        <p className="demo-hint">
          Try the demo: <strong>alice</strong> or <strong>bob</strong> ·
          password <strong>messenger-demo</strong>
        </p>
      </section>
    </main>
  );
}
