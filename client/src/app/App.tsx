import { useCallback, useEffect, useState } from 'react'
import { readSession, saveSession, type Session } from '../entities/session/model'
import { AuthPage } from '../pages/auth/AuthPage'
import { MessengerPage } from '../pages/messenger/MessengerPage'
import { api, ApiError } from '../shared/api/http'

export function App() {
  const [session, setSession] = useState<Session | null>(readSession)
  const [signOutError, setSignOutError] = useState<string | null>(null)

  function acceptSession(next: Session) { saveSession(next); setSession(next); setSignOutError(null) }
  const clearSession = useCallback(() => { saveSession(null); setSession(null); setSignOutError(null) }, [])
  async function signOut() {
    if (!session) return
    try {
      await api.logout(session.token)
      clearSession()
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) clearSession()
      else setSignOutError('Could not sign out. Please try again.')
    }
  }

  useEffect(() => {
    if (!session) return
    let active = true
    void api.session(session.token).catch((error: unknown) => {
      if (active && error instanceof ApiError && error.status === 401) clearSession()
    })
    return () => { active = false }
  }, [session, clearSession])

  return session
    ? <><MessengerPage key={`${session.user.id}:${session.deviceId}`} session={session} onSignOut={() => { void signOut() }} onSessionRevoked={clearSession} />
        {signOutError && <div className="toast" role="alert"><span>{signOutError}</span><button onClick={() => setSignOutError(null)} aria-label="Dismiss">×</button></div>}</>
    : <AuthPage onSession={acceptSession} />
}
