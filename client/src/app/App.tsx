import { useCallback, useEffect, useRef, useState } from 'react'
import { discardLegacySession, type Session } from '../entities/session/model'
import { AuthPage } from '../pages/auth/AuthPage'
import { MessengerPage } from '../pages/messenger/MessengerPage'
import { api, ApiError } from '../shared/api/http'

export function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [restoring, setRestoring] = useState(true)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const [signOutError, setSignOutError] = useState<string | null>(null)
  const revision = useRef(0)
  const restoreRequest = useRef<{ revision: number; promise: Promise<void> } | null>(null)

  const clearSession = useCallback(() => {
    revision.current += 1
    setSession(null)
    setRestoring(false)
    setRestoreError(null)
    setSignOutError(null)
  }, [])

  function acceptSession(next: Session) {
    revision.current += 1
    setSession(next)
    setRestoring(false)
    setRestoreError(null)
    setSignOutError(null)
  }

  const restoreSession = useCallback((options: { forceFresh?: boolean } = {}): Promise<void> => {
    if (!options.forceFresh && restoreRequest.current?.revision === revision.current)
      return restoreRequest.current.promise
    const currentRevision = ++revision.current
    setRestoreError(null)
    const request = { revision: currentRevision, promise: Promise.resolve() }
    restoreRequest.current = request
    request.promise = (async () => {
      try {
        const current = await api.session()
        if (revision.current !== currentRevision) return
        setSession((previous) =>
          previous?.user.id === current.userId &&
          previous.deviceId === current.deviceId &&
          previous.user.username === current.username
            ? previous
            : {
                user: { id: current.userId, username: current.username },
                deviceId: current.deviceId,
              },
        )
      } catch (error) {
        if (revision.current !== currentRevision) return
        if (error instanceof ApiError && error.status === 401) setSession(null)
        else setRestoreError('Could not check your session. Please try again.')
      } finally {
        if (revision.current === currentRevision) setRestoring(false)
      }
    })().finally(() => {
      if (restoreRequest.current === request) restoreRequest.current = null
    })
    return request.promise
  }, [])

  const restoreRevokedSession = useCallback(() => {
    revision.current += 1
    setSession(null)
    setRestoring(true)
    void restoreSession()
  }, [restoreSession])

  async function signOut() {
    if (!session) return
    const currentRevision = ++revision.current
    try {
      await api.forSession(session).logout()
      if (revision.current === currentRevision) clearSession()
      else await restoreSession({ forceFresh: true })
    } catch (error) {
      if (revision.current !== currentRevision) return
      if (error instanceof ApiError && error.status === 401) await restoreSession()
      else setSignOutError('Could not sign out. Please try again.')
    }
  }

  useEffect(() => {
    discardLegacySession()
    void restoreSession()
    const onFocus = () => {
      void restoreSession()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      revision.current += 1
      window.removeEventListener('focus', onFocus)
    }
  }, [restoreSession])

  if (restoring)
    return (
      <main className="auth-layout" aria-label="Checking session">
        <div className="loading-spinner" />
      </main>
    )
  if (!session && restoreError)
    return (
      <main className="auth-layout">
        <section className="auth-form-card">
          <p role="alert">{restoreError}</p>
          <button
            className="button button-primary"
            onClick={() => {
              setRestoring(true)
              void restoreSession()
            }}
          >
            Try again
          </button>
        </section>
      </main>
    )

  return session ? (
    <>
      <MessengerPage
        key={`${session.user.id}:${session.deviceId}`}
        session={session}
        onSignOut={() => {
          void signOut()
        }}
        onSessionRevoked={restoreRevokedSession}
      />
      {(signOutError || restoreError) && (
        <div className="toast" role="alert">
          <span>{signOutError || restoreError}</span>
          <button
            onClick={() => {
              setSignOutError(null)
              setRestoreError(null)
            }}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}
    </>
  ) : (
    <AuthPage onSession={acceptSession} />
  )
}
