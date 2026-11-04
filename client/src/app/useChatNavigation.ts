import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react'
import type { Chat } from '../entities/chat/model'
import type { Session, User } from '../entities/session/model'
import { ChatKind } from '../shared/api/generated/socket-vocabulary'
import type { api } from '../shared/api/http'
import { chatPath, parseChatPath, type useChatLocation } from './useChatLocation'

interface Options {
  session: Session
  sessionApi: ReturnType<typeof api.forSession>
  location: ReturnType<typeof useChatLocation>
  selectedId: string | null
  selectedRef: MutableRefObject<string | null>
  setSelectedId: Dispatch<SetStateAction<string | null>>
  setDraftChat: Dispatch<SetStateAction<Chat | undefined>>
  listChats(): Chat[]
  rememberChat(chat: Chat): void
  refreshChats(full?: boolean, invalidated?: boolean): Promise<Chat[]>
  leaveHistory(chatId: string): void
  catchUp(chatId: string, fromStart?: boolean): Promise<void>
  setError(message: string | null): void
}
export function useChatNavigation({
  session,
  sessionApi,
  location,
  selectedId,
  selectedRef,
  setSelectedId,
  setDraftChat,
  listChats,
  rememberChat,
  refreshChats,
  setError,
}: Options) {
  const { path, navigate, allowDefaultSelection } = location
  const [navigationError, setNavigationError] = useState<string | null>(null)
  const [openingConversation, setOpeningConversation] = useState(false)
  const selectChat = useCallback(
    (chatId: string, replaceLocation = false) => {
      const chat = listChats().find((item) => item.id === chatId)
      if (chat) navigate(chatPath(chat, session.user.id), replaceLocation)
      selectedRef.current = chatId
      setSelectedId(chatId)
    },
    [listChats, navigate, session.user.id],
  )

  const createDirect = useCallback(
    async (user: User) => {
      const existing = listChats().find(
        (chat) =>
          chat.kind === ChatKind.DIRECT && chat.members.some((member) => member.id === user.id),
      )
      if (existing) {
        setDraftChat(undefined)
        selectChat(existing.id)
        return existing
      }
      const draft: Chat = {
        id: `draft:${user.id}`,
        kind: ChatKind.DIRECT,
        name: null,
        members: [session.user, user],
        memberCount: 2,
        lastSequence: '0',
      }
      setDraftChat(draft)
      setSelectedId(draft.id)
      navigate(chatPath(draft, session.user.id))
      return draft
    },
    [listChats, selectChat, session.user, navigate],
  )

  const createGroup = useCallback(
    async (name: string, memberIds: string[]) => {
      const created = await sessionApi.createGroup(name, memberIds)
      rememberChat(created)
      await refreshChats(false, true)
      selectChat(created.id)
      return created
    },
    [refreshChats, selectChat, sessionApi, rememberChat],
  )

  useEffect(() => {
    if (!allowDefaultSelection.current || !selectedId) return
    const chat = listChats().find((item) => item.id === selectedId)
    if (chat) navigate(chatPath(chat, session.user.id), true)
  }, [selectedId, listChats, navigate, session.user.id, allowDefaultSelection])

  useEffect(() => {
    const target = parseChatPath(path)
    setNavigationError(null)
    setOpeningConversation(false)
    if (target.kind === 'home') {
      setSelectedId(null)
      setDraftChat(undefined)
      return
    }
    if (target.kind === 'invalid') {
      setSelectedId(null)
      setDraftChat(undefined)
      setNavigationError('This conversation link is invalid.')
      return
    }
    const current = listChats().find((chat) => chat.id === selectedRef.current)
    if (
      (target.kind === 'group' && selectedRef.current === target.id) ||
      (target.kind === 'direct' &&
        (selectedRef.current === `draft:${target.id}` ||
          (current?.kind === ChatKind.DIRECT &&
            current.members.some((member) => member.id === target.id))))
    )
      return
    let active = true
    setOpeningConversation(true)
    setSelectedId(null)
    setDraftChat(undefined)
    setError(null)
    void (async () => {
      try {
        if (target.kind === 'group') {
          const chat = await sessionApi.chat(target.id)
          if (!active) return
          if (chat.kind !== ChatKind.GROUP) throw new Error('This group could not be found.')
          rememberChat(chat)
          selectChat(chat.id, true)
        } else {
          const result = await sessionApi.directChat(target.id)
          if (!active) return
          if (result.chat) {
            rememberChat(result.chat)
            selectChat(result.chat.id, true)
          } else {
            const draft: Chat = {
              id: `draft:${result.recipient.id}`,
              kind: ChatKind.DIRECT,
              name: null,
              members: [session.user, result.recipient],
              memberCount: 2,
              lastSequence: '0',
            }
            setDraftChat(draft)
            setSelectedId(draft.id)
          }
        }
      } catch (cause) {
        if (active)
          setNavigationError(cause instanceof Error ? cause.message : 'Could not open conversation')
      } finally {
        if (active) setOpeningConversation(false)
      }
    })()
    return () => {
      active = false
    }
  }, [path, sessionApi, session.user, rememberChat, listChats, selectChat])

  return {
    selectChat,
    createDirect,
    createGroup,
    navigationError,
    openingConversation,
    clearNavigationError: () => setNavigationError(null),
  }
}
