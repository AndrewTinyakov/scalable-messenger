import { Eye, EyeOff } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { deviceId, type Session } from '../../entities/session/model'
import { api, ApiError } from '../../shared/api/http'
import { BrandMark } from '../../shared/ui/Brand'

export function AuthPage({ onSession }: { onSession: (session: Session) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<{ username?: string; password?: string }>({})

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setFieldErrors({})
    try {
      const session =
        mode === 'login'
          ? await api.login(username.trim(), password, deviceId())
          : await api.register(username.trim(), password, deviceId())
      onSession(session)
    } catch (cause) {
      const fields =
        cause instanceof ApiError
          ? {
              username:
                cause.code === 'USERNAME_TAKEN' ? cause.message : cause.fieldError('username'),
              password: cause.fieldError('password'),
            }
          : {}
      if (fields.username || fields.password) setFieldErrors(fields)
      else setError(cause instanceof Error ? cause.message : 'Could not sign in')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-layout">
      <section className="auth-card">
        <BrandMark size={56} />
        <h1>{mode === 'login' ? 'Welcome back' : 'Create your account'}</h1>
        <p className="auth-lede">
          {mode === 'login'
            ? 'Sign in to pick up your chats where you left off.'
            : 'Choose a username and password to get started.'}
        </p>
        <form onSubmit={submit}>
          <div className="field">
            <input
              id="username"
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(event) => {
                setUsername(event.target.value)
                setFieldErrors((previous) => ({ ...previous, username: undefined }))
              }}
              aria-invalid={fieldErrors.username ? true : undefined}
              aria-describedby={fieldErrors.username ? 'username-error' : undefined}
              minLength={3}
              maxLength={40}
              pattern="[A-Za-z0-9_]+"
              title="Use letters, digits, or underscore"
              required
              placeholder=" "
            />
            <label htmlFor="username">Username</label>
          </div>
          {fieldErrors.username && (
            <p className="field-error" id="username-error" role="alert">
              {fieldErrors.username}
            </p>
          )}
          <div className="field">
            <input
              id="password"
              name="password"
              type={reveal ? 'text' : 'password'}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value)
                setFieldErrors((previous) => ({ ...previous, password: undefined }))
              }}
              aria-invalid={fieldErrors.password ? true : undefined}
              aria-describedby={fieldErrors.password ? 'password-error' : undefined}
              minLength={8}
              maxLength={100}
              required
              placeholder=" "
            />
            <label htmlFor="password">Password</label>
            <button
              type="button"
              className="field-action"
              onClick={() => setReveal(!reveal)}
              aria-label={reveal ? 'Hide password' : 'Show password'}
            >
              {reveal ? <EyeOff size={19} /> : <Eye size={19} />}
            </button>
          </div>
          {fieldErrors.password && (
            <p className="field-error" id="password-error" role="alert">
              {fieldErrors.password}
            </p>
          )}
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <button className="button button-primary auth-submit" type="submit" disabled={busy}>
            {busy ? 'One moment…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>
        <div className="auth-switch">
          {mode === 'login' ? 'New here?' : 'Already have an account?'}{' '}
          <button
            type="button"
            onClick={() => {
              setMode(mode === 'login' ? 'register' : 'login')
              setError(null)
              setFieldErrors({})
            }}
          >
            {mode === 'login' ? 'Create an account' : 'Sign in'}
          </button>
        </div>
      </section>
    </main>
  )
}
