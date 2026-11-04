import { ArrowRight } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { deviceId, type Session } from '../../entities/session/model'
import { api } from '../../shared/api/http'
import { Brand } from '../../shared/ui/Brand'

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
      const session =
        mode === 'login'
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
      <section className="auth-form-card">
        <Brand />
        <div className="auth-form-content">
          <h1>{mode === 'login' ? 'Sign in' : 'Create account'}</h1>
          <form onSubmit={submit}>
            <label htmlFor="username">Username</label>
            <input
              id="username"
              name="username"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              minLength={3}
              maxLength={40}
              pattern="[A-Za-z0-9_]+"
              title="Use letters, digits, or underscore"
              required
              placeholder="yourname"
            />
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              minLength={8}
              maxLength={100}
              required
              placeholder="At least 8 characters"
            />
            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}
            <button className="button button-primary auth-submit" type="submit" disabled={busy}>
              {busy ? 'One moment…' : mode === 'login' ? 'Sign in' : 'Create account'}{' '}
              <ArrowRight size={18} />
            </button>
          </form>
          <div className="auth-switch">
            {mode === 'login' ? 'No account?' : 'Already have an account?'}{' '}
            <button
              type="button"
              onClick={() => {
                setMode(mode === 'login' ? 'register' : 'login')
                setError(null)
              }}
            >
              {mode === 'login' ? 'Create an account' : 'Sign in'}
            </button>
          </div>
        </div>
      </section>
    </main>
  )
}
