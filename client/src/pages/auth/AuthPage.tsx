import { useState, type FormEvent } from 'react'
import { ArrowRight, LockKeyhole, Radio, ShieldCheck } from 'lucide-react'
import type { Session } from '../../entities/session/model'
import { api } from '../../shared/api/http'
import { createUlid } from '../../shared/lib/id'
import { Brand } from '../../shared/ui/Brand'

const deviceKey = 'relay.device.v1'

function deviceId(): string {
  const existing = localStorage.getItem(deviceKey)
  if (existing) return existing
  const created = createUlid()
  localStorage.setItem(deviceKey, created)
  return created
}

export function AuthPage({ onSession }: { onSession: (session: Session) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const session = mode === 'login'
        ? await api.login(username.trim(), password, deviceId())
        : await api.register(username.trim(), password, deviceId())
      onSession(session)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not sign in')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-layout">
      <section className="auth-story">
        <Brand />
        <div className="auth-story-content">
          <div className="eyebrow"><span className="eyebrow-line" /> A clearer way to keep in touch</div>
          <h1>Good conversations<br /><em>stay with you.</em></h1>
          <p>Pick up where you left off, on any device. Every message has its place.</p>
          <div className="story-thread" aria-hidden="true">
            <div className="story-thread-top"><span className="thread-avatar">M</span><span>Maya <small>now</small></span><span className="thread-dots">···</span></div>
            <div className="story-bubble story-bubble-left">Are we still on for Sunday?</div>
            <div className="story-bubble story-bubble-right">Absolutely. Coffee at ten?</div>
            <div className="story-bubble story-bubble-left">Perfect ☕</div>
            <div className="story-thread-foot"><span className="live-dot" /> Conversation saved</div>
          </div>
        </div>
        <div className="story-footer"><Radio size={15} /> Connected by the moments in between</div>
      </section>

      <section className="auth-form-wrap">
        <div className="auth-form-card">
          <div className="auth-form-icon"><LockKeyhole size={22} strokeWidth={1.6} /></div>
          <div className="form-kicker">Your space, ready when you are</div>
          <h2>{mode === 'login' ? 'Welcome back.' : 'Join the conversation.'}</h2>
          <p className="form-intro">{mode === 'login' ? 'Sign in to find your conversations.' : 'Create an account to start talking.'}</p>
          <form onSubmit={submit}>
            <label htmlFor="username">Username</label>
            <input id="username" name="username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} minLength={3} maxLength={40} pattern="[A-Za-z0-9_]+" title="Use letters, digits, or underscore" required placeholder="yourname" />
            <label htmlFor="password">Password</label>
            <input id="password" name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} maxLength={100} required placeholder="At least 8 characters" />
            {error && <div className="form-error" role="alert">{error}</div>}
            <button className="button button-primary auth-submit" type="submit" disabled={busy}>
              {busy ? 'One moment…' : mode === 'login' ? 'Sign in' : 'Create account'} <ArrowRight size={18} />
            </button>
          </form>
          <div className="auth-switch">
            {mode === 'login' ? 'New to Relay?' : 'Already have an account?'}{' '}
            <button type="button" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(null) }}>
              {mode === 'login' ? 'Create an account' : 'Sign in'}
            </button>
          </div>
          <div className="auth-note"><ShieldCheck size={16} /> Your history follows your account across devices.</div>
        </div>
      </section>
    </main>
  )
}
