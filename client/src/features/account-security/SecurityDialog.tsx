import { KeyRound, Laptop, MonitorSmartphone, RefreshCw, Smartphone } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { ActiveSession, Session } from '../../entities/session/model'
import { api, ApiError } from '../../shared/api/http'
import { Dialog } from '../../shared/ui/Dialog'

const sessionTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

interface Props {
  session: Session
  onClose(): void
  onSignOut(): void
  onSessionInvalid(): void
}

type Busy = { kind: 'session'; id: string } | { kind: 'others' } | { kind: 'password' } | null

function message(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback
}

function deviceIcon(label: string) {
  return /\b(iOS|Android)\b/.test(label) ? (
    <Smartphone size={20} aria-hidden="true" />
  ) : /\biPadOS\b/.test(label) ? (
    <MonitorSmartphone size={20} aria-hidden="true" />
  ) : (
    <Laptop size={20} aria-hidden="true" />
  )
}

function signedOutNotice(count: number, prefix = ''): string {
  if (count === 0) return `${prefix}No other devices were signed in.`
  return `${prefix}Signed out ${count} other ${count === 1 ? 'device' : 'devices'}.`
}

export function SecurityDialog({ session, onClose, onSignOut, onSessionInvalid }: Props) {
  const sessionApi = useMemo(() => api.forSession(session), [session.user.id, session.deviceId])
  const [sessions, setSessions] = useState<ActiveSession[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [confirmOthers, setConfirmOthers] = useState(false)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [passwordNotice, setPasswordNotice] = useState<string | null>(null)
  const active = useRef(true)
  const revision = useRef(0)
  const sessionInvalid = useRef(onSessionInvalid)
  sessionInvalid.current = onSessionInvalid

  const handleFailure = useCallback(
    (cause: unknown, fallback: string, report: (value: string) => void) => {
      if (cause instanceof ApiError && cause.status === 401) {
        sessionInvalid.current()
        return
      }
      report(message(cause, fallback))
    },
    [],
  )

  const reload = useCallback(async () => {
    const current = ++revision.current
    setLoading(true)
    setListError(null)
    try {
      const loaded = await sessionApi.sessions()
      if (!active.current || current !== revision.current) return
      setSessions(loaded)
    } catch (cause) {
      if (active.current && current === revision.current)
        handleFailure(cause, 'Could not load your devices', setListError)
    } finally {
      if (active.current && current === revision.current) setLoading(false)
    }
  }, [sessionApi, handleFailure])

  useEffect(() => {
    active.current = true
    void reload()
    return () => {
      active.current = false
      revision.current += 1
    }
  }, [reload])

  async function revoke(target: ActiveSession) {
    if (busy) return
    if (target.current) {
      onSignOut()
      return
    }
    setBusy({ kind: 'session', id: target.id })
    setSessionError(null)
    setNotice(null)
    try {
      await sessionApi.revokeSession(target.id)
      if (!active.current) return
      setSessions((previous) => previous.filter((item) => item.id !== target.id))
      setNotice(`Signed out ${target.deviceLabel}.`)
    } catch (cause) {
      if (!active.current) return
      if (cause instanceof ApiError && cause.status === 404) {
        setSessions((previous) => previous.filter((item) => item.id !== target.id))
        setNotice('That device was already signed out.')
      } else handleFailure(cause, 'Could not sign out that device', setSessionError)
    } finally {
      if (active.current) setBusy(null)
    }
  }

  async function revokeOthers() {
    if (busy) return
    setBusy({ kind: 'others' })
    setSessionError(null)
    setNotice(null)
    try {
      const count = await sessionApi.revokeOtherSessions()
      if (!active.current) return
      setConfirmOthers(false)
      setNotice(signedOutNotice(count))
      await reload()
    } catch (cause) {
      if (active.current) handleFailure(cause, 'Could not sign out other devices', setSessionError)
    } finally {
      if (active.current) setBusy(null)
    }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setPasswordError(null)
    setPasswordNotice(null)
    if (newPassword !== confirmPassword) {
      setPasswordError('New passwords do not match.')
      return
    }
    if (newPassword === currentPassword) {
      setPasswordError('Choose a password that differs from your current one.')
      return
    }
    setBusy({ kind: 'password' })
    try {
      const count = await sessionApi.changePassword(currentPassword, newPassword)
      if (!active.current) return
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setPasswordNotice(signedOutNotice(count, 'Password changed. '))
      await reload()
    } catch (cause) {
      if (!active.current) return
      if (cause instanceof ApiError && cause.code === 'INVALID_CREDENTIALS') setCurrentPassword('')
      if (cause instanceof ApiError && cause.code === 'PASSWORD_CHANGED') {
        setCurrentPassword('')
        setNewPassword('')
        setConfirmPassword('')
        void reload()
      }
      handleFailure(cause, 'Could not change your password', setPasswordError)
    } finally {
      if (active.current) setBusy(null)
    }
  }

  const others = sessions.filter((item) => !item.current).length
  const working = busy !== null

  return (
    <Dialog title="Devices and password" onClose={onClose} busy={working}>
      <section className="security-section" aria-labelledby="security-devices-title">
        <div className="security-section-head">
          <h3 id="security-devices-title">Signed-in devices</h3>
          <button
            className="icon-button"
            onClick={() => void reload()}
            disabled={loading || working}
            aria-label="Refresh devices"
          >
            <RefreshCw size={17} />
          </button>
        </div>
        {listError && (
          <div className="form-error" role="alert">
            {listError}{' '}
            <button className="text-button" onClick={() => void reload()} disabled={working}>
              Try again
            </button>
          </div>
        )}
        {sessionError && (
          <div className="form-error" role="alert">
            {sessionError}
          </div>
        )}
        {notice && (
          <p className="members-notice" role="status">
            {notice}
          </p>
        )}
        {loading && sessions.length === 0 && !listError ? (
          <p className="members-loading" role="status">
            Loading devices…
          </p>
        ) : (
          <ul className="security-sessions" aria-label="Signed-in devices" aria-busy={loading}>
            {sessions.map((item) => (
              <li key={item.id} className="security-session">
                <span className="security-session-icon">{deviceIcon(item.deviceLabel)}</span>
                <span className="security-session-copy">
                  <strong>
                    {item.deviceLabel}
                    {item.current && <small className="security-current">This device</small>}
                  </strong>
                  <small>
                    Last active {sessionTime.format(new Date(item.lastUsedAt))} · Signed in{' '}
                    {sessionTime.format(new Date(item.createdAt))}
                  </small>
                </span>
                <button
                  className="member-remove"
                  disabled={working}
                  onClick={() => void revoke(item)}
                  aria-label={
                    item.current ? 'Sign out of this device' : `Sign out ${item.deviceLabel}`
                  }
                >
                  {busy?.kind === 'session' && busy.id === item.id ? 'Signing out…' : 'Sign out'}
                </button>
              </li>
            ))}
          </ul>
        )}
        {confirmOthers ? (
          <div className="member-confirmation">
            <span>Sign out every other device?</span>
            <div>
              <button
                className="member-remove"
                disabled={working}
                onClick={() => void revokeOthers()}
              >
                {busy?.kind === 'others' ? 'Signing out…' : 'Sign out all'}
              </button>
              <button
                className="member-cancel"
                disabled={working}
                onClick={() => setConfirmOthers(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            className="button button-danger-ghost security-others"
            disabled={working || loading || others === 0}
            onClick={() => setConfirmOthers(true)}
          >
            Sign out all other devices
          </button>
        )}
      </section>
      <section className="security-section" aria-labelledby="security-password-title">
        <div className="security-section-head">
          <h3 id="security-password-title">
            <KeyRound size={17} aria-hidden="true" /> Change password
          </h3>
        </div>
        <p className="dialog-description">
          Changing your password signs out every other device. This device stays signed in.
        </p>
        <form className="security-password" onSubmit={(event) => void changePassword(event)}>
          <input
            type="text"
            name="username"
            autoComplete="username"
            value={session.user.username}
            readOnly
            hidden
          />
          <div className="field">
            <input
              id="security-current-password"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              maxLength={100}
              required
              disabled={working}
              placeholder=" "
            />
            <label htmlFor="security-current-password">Current password</label>
          </div>
          <div className="field">
            <input
              id="security-new-password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              minLength={8}
              maxLength={100}
              required
              disabled={working}
              placeholder=" "
            />
            <label htmlFor="security-new-password">New password</label>
          </div>
          <div className="field">
            <input
              id="security-confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              minLength={8}
              maxLength={100}
              required
              disabled={working}
              placeholder=" "
            />
            <label htmlFor="security-confirm-password">Confirm new password</label>
          </div>
          {passwordError && (
            <div className="form-error" role="alert">
              {passwordError}
            </div>
          )}
          {passwordNotice && (
            <p className="members-notice" role="status">
              {passwordNotice}
            </p>
          )}
          <div className="dialog-actions">
            <button className="button button-primary" type="submit" disabled={working}>
              {busy?.kind === 'password' ? 'Changing…' : 'Change password'}
            </button>
          </div>
        </form>
      </section>
    </Dialog>
  )
}
