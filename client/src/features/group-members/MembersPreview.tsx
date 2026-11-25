import { useEffect, useRef, useState } from 'react'
import type { User } from '../../entities/session/model'
import { Avatar } from '../../shared/ui/Avatar'
import { isOnline, presenceLabel } from '../presence/presenceLabel'
import { usePresence } from '../presence/usePresence'

export type MemberPage = { members: User[]; nextCursor?: string | null }

interface Props {
  chatId: string
  ownerId?: string | null
  load(chatId: string, after?: string): Promise<MemberPage>
}

/** A paginated member list with live status, shown while hovering the member count. */
export function MembersPreview({ chatId, ownerId, load }: Props) {
  const [members, setMembers] = useState<User[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const loading = useRef(false)
  const presence = usePresence(
    'members',
    members.map((member) => member.id),
  )
  async function fetchPage(after?: string) {
    if (loading.current) return
    loading.current = true
    try {
      const page = await load(chatId, after)
      setMembers((previous) => (after ? [...previous, ...page.members] : page.members))
      setCursor(page.nextCursor ?? null)
    } catch {
      setCursor(null)
    } finally {
      loading.current = false
    }
  }
  useEffect(() => {
    void fetchPage()
  }, [chatId])
  return (
    <div className="members-preview" role="dialog" aria-label="Members">
      <ul
        onScroll={(event) => {
          const list = event.currentTarget
          if (cursor && list.scrollTop + list.clientHeight >= list.scrollHeight - 48)
            void fetchPage(cursor)
        }}
      >
        {members.map((member) => {
          const status = presence.get(member.id)
          return (
            <li key={member.id}>
              <Avatar seed={member.id} name={member.username} size={36} online={isOnline(status)} />
              <span>
                <strong>{member.username}</strong>
                <small className={isOnline(status) ? 'online' : undefined}>
                  {presenceLabel(status)}
                </small>
              </span>
              {member.id === ownerId && <em>owner</em>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
