import { WifiOff } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { discardLegacySession, type Session } from '../entities/session/model'
import { AuthPage } from '../pages/auth/AuthPage'
import { MessengerPage } from '../pages/messenger/MessengerPage'
import { api, ApiError } from '../shared/api/http'
import { isNetworkOnline, subscribeNetwork } from '../shared/lib/network'

type SessionLifecycle =
  | { phase: 'restoring'; session: Session | null }
  | { phase: 'anonymous' }
  | { phase: 'authenticated'; session: Session }
  | { phase: 'failed'; session: Session | null; message: string }

function sessionOf(state: SessionLifecycle): Session | null {
  return 'session' in state ? state.session : null
}

function clearRestoreError(state: SessionLifecycle): SessionLifecycle {
  if (state.phase !== 'failed') return state
  return state.session ? { phase: 'authenticated', session: state.session } : { phase: 'anonymous' }
}

export function App() {
  const online = useSyncExternalStore(subscribeNetwork, isNetworkOnline)
  const [state, setState] = useState<SessionLifecycle>({ phase: 'restoring', session: null })
  const session = sessionOf(state)
  const restoring = state.phase === 'restoring'
  const restoreError = state.phase === 'failed' ? state.message : null
  const [signOutError, setSignOutError] = useState<string | null>(null)
  const revision = useRef(0)
  const restoreRequest = useRef<{ revision: number; promise: Promise<void> } | null>(null)

  const clearSession = useCallback(() => {
    revision.current += 1
    setState({ phase: 'anonymous' })
    setSignOutError(null)
  }, [])

  function acceptSession(next: Session) {
    revision.current += 1
    setState({ phase: 'authenticated', session: next })
    setSignOutError(null)
  }

  const restoreSession = useCallback((options: { forceFresh?: boolean } = {}): Promise<void> => {
    if (!isNetworkOnline()) return Promise.resolve()
    if (!options.forceFresh && restoreRequest.current?.revision === revision.current)
      return restoreRequest.current.promise
    const currentRevision = ++revision.current
    setState(clearRestoreError)
    const request = { revision: currentRevision, promise: Promise.resolve() }
    restoreRequest.current = request
    request.promise = (async () => {
      try {
        const current = await api.session()
        if (revision.current !== currentRevision) return
        setState((previous) => {
          const retained = sessionOf(previous)
          return {
            phase: 'authenticated',
            session:
              retained?.user.id === current.userId &&
              retained.deviceId === current.deviceId &&
              retained.user.username === current.username
                ? retained
                : {
                    user: { id: current.userId, username: current.username },
                    deviceId: current.deviceId,
                  },
          }
        })
      } catch (error) {
        if (revision.current !== currentRevision) return
        if (error instanceof ApiError && error.status === 401) setState({ phase: 'anonymous' })
        else if (isNetworkOnline())
          setState((previous) => ({
            phase: 'failed',
            session: sessionOf(previous),
            message: 'Could not check your session. Please try again.',
          }))
      } finally {
        if (revision.current === currentRevision)
          setState((previous) =>
            previous.phase === 'restoring'
              ? previous.session
                ? { phase: 'authenticated', session: previous.session }
                : { phase: 'anonymous' }
              : previous,
          )
      }
    })().finally(() => {
      if (restoreRequest.current === request) restoreRequest.current = null
    })
    return request.promise
  }, [])

  const restoreRevokedSession = useCallback(() => {
    revision.current += 1
    setState({ phase: 'restoring', session: null })
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
    const onFocus = () => {
      void restoreSession()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      revision.current += 1
      window.removeEventListener('focus', onFocus)
    }
  }, [restoreSession])

  useEffect(() => {
    setState((previous) => ({ phase: 'restoring', session: sessionOf(previous) }))
    if (online) void restoreSession()
    else {
      revision.current += 1
      setState(clearRestoreError)
      setSignOutError(null)
    }
  }, [online, restoreSession])

  if (!session && !online)
    return (
      <main className="auth-layout">
        <section className="auth-card" role="status">
          <span className="auth-offline-icon">
            <WifiOff size={30} aria-hidden="true" />
          </span>
          <h1>You're offline</h1>
          <p className="auth-lede">
            Waiting for a connection. We'll check your session automatically when you're back
            online.
          </p>
        </section>
      </main>
    )
  if (restoring && !session)
    return (
      <main className="auth-layout" aria-label="Checking session">
        <div className="loading-spinner" />
      </main>
    )
  if (!session && restoreError)
    return (
      <main className="auth-layout">
        <section className="auth-card">
          <p role="alert">{restoreError}</p>
          <button
            className="button button-primary"
            onClick={() => {
              setState((previous) => ({ phase: 'restoring', session: sessionOf(previous) }))
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
              setState(clearRestoreError)
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
