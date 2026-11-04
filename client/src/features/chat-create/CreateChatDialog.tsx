import { ArrowLeft, Check, Search, Users, X } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { Session, User } from '../../entities/session/model'
import { api } from '../../shared/api/http'

interface Props {
  session: Session
  currentUserId: string
  onClose: () => void
  onDirect: (user: User) => Promise<unknown>
  onGroup: (name: string, memberIds: string[]) => Promise<unknown>
}

export function CreateChatDialog({ session, currentUserId, onClose, onDirect, onGroup }: Props) {
  const sessionApi = useMemo(() => api.forSession(session), [session.user.id, session.deviceId])
  const [mode, setMode] = useState<'direct' | 'group'>('direct')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<User[]>([])
  const [selected, setSelected] = useState<User[]>([])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const timer = window.setTimeout(() => {
      if (!query.trim()) {
        setResults([])
        return
      }
      void sessionApi
        .users(query.trim())
        .then((users) => {
          if (active) {
            setResults(users.filter((user) => user.id !== currentUserId))
            setError(null)
          }
        })
        .catch((cause) => {
          if (active) setError(cause instanceof Error ? cause.message : 'Search failed')
        })
    }, 220)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [currentUserId, query, sessionApi])

  async function direct(user: User) {
    setBusy(true)
    setError(null)
    try {
      await onDirect(user)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not open chat')
    } finally {
      setBusy(false)
    }
  }

  async function group(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!name.trim() || selected.length < 1) return
    setBusy(true)
    setError(null)
    try {
      await onGroup(
        name.trim(),
        selected.map((user) => user.id),
      )
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create group')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        className="create-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-title"
      >
        <div className="dialog-head">
          <h2 id="create-title">New chat</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </div>
        <div className="dialog-tabs" role="tablist" aria-label="Chat type">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'direct'}
            className={mode === 'direct' ? 'active' : ''}
            onClick={() => setMode('direct')}
          >
            One to one
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'group'}
            className={mode === 'group' ? 'active' : ''}
            onClick={() => setMode('group')}
          >
            Group
          </button>
        </div>
        {mode === 'group' && (
          <div className="dialog-group-name">
            <label htmlFor="group-name">Group name</label>
            <input
              id="group-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Friday plans"
              maxLength={80}
              form="group-form"
              required
            />
          </div>
        )}
        <div className="dialog-search">
          <Search size={18} />
          <input
            aria-label="Find people"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search people by username"
            autoFocus
          />
        </div>
        {mode === 'group' && selected.length > 0 && (
          <div className="selected-people">
            {selected.map((user) => (
              <button
                key={user.id}
                type="button"
                onClick={() => setSelected(selected.filter((item) => item.id !== user.id))}
              >
                {user.username}
                <X size={13} />
              </button>
            ))}
          </div>
        )}
        <div className="people-results">
          {!query.trim() && (
            <div className="people-hint">
              <Users size={22} /> Type a name to find someone.
            </div>
          )}
          {query.trim() && results.length === 0 && (
            <div className="people-hint">No matching people yet.</div>
          )}
          {results.map((user) => {
            const checked = selected.some((item) => item.id === user.id)
            return (
              <button
                key={user.id}
                className="person-row"
                type="button"
                disabled={busy}
                onClick={() =>
                  mode === 'direct'
                    ? void direct(user)
                    : setSelected(
                        checked
                          ? selected.filter((item) => item.id !== user.id)
                          : [...selected, user],
                      )
                }
              >
                <span className="person-avatar">{user.username[0]?.toUpperCase()}</span>
                <span>{user.username}</span>
                {mode === 'group' ? (
                  <span className={`person-check ${checked ? 'checked' : ''}`}>
                    {checked && <Check size={14} />}
                  </span>
                ) : (
                  <ArrowLeft size={17} className="person-arrow" />
                )}
              </button>
            )
          })}
        </div>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        {mode === 'group' && (
          <form id="group-form" onSubmit={group} className="dialog-footer">
            <span>
              {selected.length} {selected.length === 1 ? 'person' : 'people'} selected
            </span>
            <button
              className="button button-primary"
              disabled={busy || !name.trim() || selected.length < 1}
            >
              Create group
            </button>
          </form>
        )}
      </section>
    </div>
  )
}
