import { Check, CheckCheck, ChevronDown, CircleAlert, Clock3 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Message } from '../../entities/message/model'
import type { ReaderPage } from '../../shared/api/featureDecode'
import { formatReadTime } from '../../shared/lib/time'
import { Avatar } from '../../shared/ui/Avatar'

interface Props {
  message: Message
  group?: boolean
  load(chatId: string, messageId: string, afterUserId?: string): Promise<ReaderPage>
}
export function InlineReaders({ message, group = false, load }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [readers, setReaders] = useState<ReaderPage['readers']>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [available, setAvailable] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const active = useRef(true)
  const busy = useRef(false)
  const expiry = useRef<ReturnType<typeof setTimeout>>()
  async function fetchPage(after?: string) {
    if (busy.current) return
    busy.current = true
    setLoading(true)
    setError(null)
    try {
      const page = await load(message.chatId, message.id, after)
      if (!active.current) return
      setAvailable(page.detailsAvailable)
      setReaders((previous) =>
        [
          ...new Map(
            [...(after ? previous : []), ...page.readers].map((reader) => [reader.userId, reader]),
          ).values(),
        ].slice(-200),
      )
      setCursor(page.nextUserId)
      clearTimeout(expiry.current)
      if (page.detailsAvailable && page.detailsExpiresAt) {
        const remaining = Date.parse(page.detailsExpiresAt) - Date.parse(page.serverTime)
        expiry.current = setTimeout(
          () => {
            setAvailable(false)
            setReaders([])
            setCursor(null)
          },
          Math.max(0, Math.min(remaining, 2147483647)),
        )
      }
    } catch (cause) {
      if (active.current)
        setError(cause instanceof Error ? cause.message : 'Could not load readers')
    } finally {
      busy.current = false
      if (active.current) setLoading(false)
    }
  }
  useEffect(() => {
    active.current = !message.deletedAt
    if (active.current) void fetchPage()
    return () => {
      active.current = false
      clearTimeout(expiry.current)
    }
  }, [message.id, message.deletedAt])
  const fullTime = (at: string) =>
    new Date(at).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'long' })
  const stamp = (at: string) => (
    <time dateTime={at} title={fullTime(at)}>
      {formatReadTime(at)}
    </time>
  )
  let body
  if (message.deletedAt)
    body = <p className="reader-row">Read times are unavailable for deleted messages.</p>
  else if (!available)
    body = (
      <p className="reader-row">
        <Clock3 size={17} />
        Read times are kept for 7 days
      </p>
    )
  else if (error)
    body = (
      <div className="reader-row" role="alert" title={error}>
        <CircleAlert size={17} />
        Couldn’t load read times
        <button className="text-button" onClick={() => void fetchPage(cursor ?? undefined)}>
          Try again
        </button>
      </div>
    )
  else if (!readers.length)
    body = loading ? (
      <p className="reader-row" role="status" aria-label="Loading readers">
        <CheckCheck size={17} />
        <i className="reader-skeleton" />
      </p>
    ) : (
      <p className="reader-row unread">
        <Check size={17} />
        Not read yet
      </p>
    )
  else if (!group)
    body = (
      <p className="reader-row">
        <CheckCheck size={17} />
        {stamp(readers[0].readAt)}
      </p>
    )
  else
    body = (
      <>
        <button
          className="reader-row"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <CheckCheck size={17} />
          {readers.length}
          {cursor ? '+' : ''} seen
          <span className="reader-faces" aria-hidden="true">
            {readers.slice(0, 3).map((reader) => (
              <Avatar key={reader.userId} seed={reader.userId} name={reader.username} size={22} />
            ))}
          </span>
          <ChevronDown className="reader-chevron" size={16} />
        </button>
        {expanded && (
          <ul className="reader-list">
            {readers.map((reader) => (
              <li key={reader.userId}>
                <Avatar seed={reader.userId} name={reader.username} size={28} />
                <strong>{reader.username}</strong>
                {stamp(reader.readAt)}
              </li>
            ))}
            {cursor && (
              <li>
                <button
                  className="text-button"
                  disabled={loading}
                  onClick={() => void fetchPage(cursor)}
                >
                  {loading ? 'Loading…' : 'More readers'}
                </button>
              </li>
            )}
          </ul>
        )}
      </>
    )
  return (
    <section className="inline-readers" aria-label="Read times">
      {body}
    </section>
  )
}
