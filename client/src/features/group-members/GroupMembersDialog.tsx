import { RefreshCw, Search, UserPlus, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Chat } from '../../entities/chat/model'
import type { Session, User } from '../../entities/session/model'
import { api } from '../../shared/api/http'
import { Avatar } from '../../shared/ui/Avatar'
import { fadeOutDialog, useExitAnimation } from '../../shared/ui/useExitAnimation'
import { isOnline, presenceLabel } from '../presence/presenceLabel'
import { usePresence } from '../presence/usePresence'

interface Props {
  chat: Chat
  session: Session
  onClose(): void
  onUpdated(chat: Chat): void
}

export function GroupMembersDialog({ chat, session, onClose, onUpdated }: Props) {
  const sessionApi = useMemo(() => api.forSession(session), [session.user.id, session.deviceId])
  const [details, setDetails] = useState(chat)
  const [members, setMembers] = useState<User[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmRemoval, setConfirmRemoval] = useState<User | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<User[]>([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const active = useRef(true)
  const revision = useRef(0)
  const busyRef = useRef(false)
  const dialogRef = useRef<HTMLElement>(null)
  const backdrop = useRef<HTMLDivElement>(null)
  useExitAnimation(backdrop, fadeOutDialog)
  const presence = usePresence(
    'members',
    members.map((member) => member.id),
  )
  const owner = details.ownerId === session.user.id

  const reload = useCallback(async () => {
    const current = ++revision.current
    setLoading(true)
    setLoadingMore(false)
    try {
      const [opened, page] = await Promise.all([
        sessionApi.chat(chat.id),
        sessionApi.groupMembers(chat.id),
      ])
      if (!active.current || current !== revision.current) return
      setDetails(opened)
      setMembers(page.members)
      setNextCursor(page.nextCursor ?? null)
      setError(null)
      onUpdated(opened)
    } catch (cause) {
      if (active.current && current === revision.current)
        setError(cause instanceof Error ? cause.message : 'Could not load members')
      throw cause
    } finally {
      if (active.current && current === revision.current) setLoading(false)
    }
  }, [chat.id, sessionApi, onUpdated])

  useEffect(() => {
    active.current = true
    const previousFocus = document.activeElement
    dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    void reload().catch(() => {})
    const focus = () => {
      if (!busyRef.current) void reload().catch(() => {})
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) onClose()
      if (event.key !== 'Tab') return
      const controls = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled)',
      )
      const first = controls?.[0]
      const last = controls?.[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    window.addEventListener('focus', focus)
    window.addEventListener('keydown', escape)
    return () => {
      active.current = false
      revision.current += 1
      window.removeEventListener('focus', focus)
      window.removeEventListener('keydown', escape)
      if (previousFocus instanceof HTMLElement) previousFocus.focus()
    }
  }, [reload, onClose])

  useEffect(() => {
    if (
      (chat.memberCount !== details.memberCount || chat.members !== details.members) &&
      !busyRef.current
    )
      void reload().catch(() => {})
  }, [chat.memberCount, chat.members, details.memberCount, details.members, busy, reload])

  useEffect(() => {
    let current = true
    setResults([])
    setSearchError(null)
    setSearching(Boolean(owner && query.trim()))
    if (!owner || !query.trim()) return
    const timer = window.setTimeout(() => {
      void sessionApi
        .users(query.trim())
        .then((users) => {
          if (current) setResults(users)
        })
        .catch((cause) => {
          if (current) setSearchError(cause instanceof Error ? cause.message : 'Search failed')
        })
        .finally(() => {
          if (current) setSearching(false)
        })
    }, 220)
    return () => {
      current = false
      window.clearTimeout(timer)
    }
  }, [owner, query, sessionApi])

  async function loadMore() {
    if (!nextCursor || loading || loadingMore || busy) return
    const current = revision.current
    setLoadingMore(true)
    try {
      const page = await sessionApi.groupMembers(chat.id, nextCursor)
      if (!active.current || current !== revision.current) return
      setMembers((previous) => {
        const known = new Set(previous.map((member) => member.id))
        return [...previous, ...page.members.filter((member) => !known.has(member.id))]
      })
      setNextCursor(page.nextCursor ?? null)
    } catch (cause) {
      if (active.current && current === revision.current)
        setError(cause instanceof Error ? cause.message : 'Could not load more members')
    } finally {
      if (active.current && current === revision.current) setLoadingMore(false)
    }
  }

  async function changeMember(user: User, remove: boolean) {
    if (busyRef.current || !owner) return
    busyRef.current = true
    setBusy(user.id)
    setError(null)
    setNotice(null)
    try {
      if (remove) await sessionApi.removeGroupMember(chat.id, user.id)
      else await sessionApi.addGroupMembers(chat.id, [user.id])
      if (!active.current) return
      await reload()
      if (!active.current) return
      setConfirmRemoval(null)
      setQuery('')
      setNotice('Member list updated.')
    } catch (cause) {
      if (active.current)
        setError(cause instanceof Error ? cause.message : 'Could not update members')
    } finally {
      busyRef.current = false
      if (active.current) setBusy(null)
    }
  }

  const knownIds = new Set(members.map((member) => member.id))
  const candidates = results.filter((user) => user.id !== session.user.id && !knownIds.has(user.id))

  return (
    <div
      ref={backdrop}
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busyRef.current) onClose()
      }}
    >
      <section
        ref={dialogRef}
        className="create-dialog group-members-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="members-title"
        aria-busy={loading || Boolean(busy)}
      >
        <div className="dialog-head">
          <div>
            <h2 id="members-title">Group members</h2>
            <p className="members-group-name">{details.name}</p>
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            disabled={Boolean(busy)}
            aria-label="Close members"
          >
            <X size={20} />
          </button>
        </div>
        <div className="members-summary">
          <span>
            {details.memberCount} {details.memberCount === 1 ? 'member' : 'members'}
          </span>
          <button
            className="icon-button"
            onClick={() => void reload().catch(() => {})}
            disabled={loading || Boolean(busy)}
            aria-label="Refresh members"
          >
            <RefreshCw size={17} />
          </button>
        </div>
        {!owner && (
          <p className="members-permissions">Only the group owner can add or remove members.</p>
        )}
        {(error || searchError) && (
          <div className="form-error" role="alert">
            {error || searchError}
          </div>
        )}
        {notice && (
          <p className="members-notice" role="status">
            {notice}
          </p>
        )}
        <ul className="members-list" aria-label="Group members">
          {members.map((member) => (
            <li key={member.id} className="group-member-row">
              <div className="group-member-main">
                <Avatar
                  seed={member.id}
                  name={member.username}
                  size={42}
                  online={isOnline(presence.get(member.id))}
                />
                <span className="group-member-name">
                  {member.username}
                  {member.id === session.user.id && <small>You</small>}
                  {presence.has(member.id) && (
                    <small
                      className={`member-presence ${isOnline(presence.get(member.id)) ? 'online' : 'offline'}`}
                    >
                      {presenceLabel(presence.get(member.id))}
                    </small>
                  )}
                </span>
                {member.id === details.ownerId ? (
                  <span className="member-owner">Owner</span>
                ) : (
                  owner && (
                    <button
                      className="member-remove"
                      disabled={loading || Boolean(busy)}
                      onClick={() => setConfirmRemoval(member)}
                      aria-label={`Remove ${member.username}`}
                    >
                      Remove
                    </button>
                  )
                )}
              </div>
              {confirmRemoval?.id === member.id && (
                <div className="member-confirmation">
                  <span>Remove {member.username} from this group?</span>
                  <div>
                    <button
                      className="member-remove"
                      disabled={Boolean(busy)}
                      aria-label={`Confirm removing ${member.username}`}
                      onClick={() => void changeMember(member, true)}
                    >
                      {busy === member.id ? 'Removing…' : 'Remove member'}
                    </button>
                    <button
                      className="member-cancel"
                      disabled={Boolean(busy)}
                      onClick={() => setConfirmRemoval(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
        {loading && (
          <p className="members-loading" role="status">
            Loading members…
          </p>
        )}
        {nextCursor && (
          <button
            className="history-page-button"
            disabled={loading || loadingMore || Boolean(busy)}
            onClick={() => void loadMore()}
          >
            {loadingMore ? 'Loading…' : 'Load more members'}
          </button>
        )}
        {owner && (
          <div className="member-add-section">
            <h3>
              <UserPlus size={17} /> Add people
            </h3>
            <label className="dialog-search">
              <Search size={17} />
              <input
                aria-label="Find people to add"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                maxLength={40}
                placeholder="Search by username"
                disabled={Boolean(busy)}
              />
            </label>
            {searching && (
              <p className="members-loading" role="status">
                Searching…
              </p>
            )}
            {query.trim() && !searching && candidates.length === 0 && (
              <p className="members-loading">No new people found.</p>
            )}
            <div className="member-add-results">
              {candidates.map((user) => (
                <div key={user.id} className="group-member-main">
                  <Avatar seed={user.id} name={user.username} size={42} />
                  <span className="group-member-name">{user.username}</span>
                  <button
                    className="member-add"
                    disabled={loading || Boolean(busy)}
                    aria-label={`Add ${user.username}`}
                    onClick={() => void changeMember(user, false)}
                  >
                    {busy === user.id ? 'Adding…' : 'Add'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
