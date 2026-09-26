import { useEffect, useState } from 'react'
import { readSession, saveSession, type Session } from '../entities/session/model'
import { AuthPage } from '../pages/auth/AuthPage'
import { MessengerPage } from '../pages/messenger/MessengerPage'
import { api, ApiError } from '../shared/api/http'

export function App() {
  const [session, setSession] = useState<Session | null>(readSession)

  function acceptSession(next: Session) { saveSession(next); setSession(next) }
  function signOut() { saveSession(null); setSession(null) }

  useEffect(() => {
    if (!session) return
    let active = true
    void api.session(session.token).catch((error: unknown) => {
      if (active && error instanceof ApiError && error.status === 401) signOut()
    })
    return () => { active = false }
  }, [session])

  return session
    ? <MessengerPage key={`${session.user.id}:${session.deviceId}`} session={session} onSignOut={signOut} />
    : <AuthPage onSession={acceptSession} />
}
