import { useEffect, useRef, useState } from 'react'
import type { Message } from '../../entities/message/model'
import type { ReaderPage } from '../../shared/api/featureDecode'
import { Avatar } from '../../shared/ui/Avatar'

interface Props {
  message: Message
  load(chatId: string, messageId: string, afterUserId?: string): Promise<ReaderPage>
}
export function InlineReaders({ message, load }: Props) {
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
  return (
    <section className="inline-readers" aria-label="Read times">
      <h3>Read times</h3>
      {message.deletedAt ? (
        <p className="receipt-empty">Read times are unavailable for deleted messages.</p>
      ) : !available ? (
        <p className="receipt-empty">
          Timestamps are available for messages created within the last seven days.
        </p>
      ) : (
        <>
          <ul className="reader-list">
            {readers.map((reader) => (
              <li key={reader.userId}>
                <Avatar seed={reader.userId} name={reader.username} size={28} />
                <strong>{reader.username}</strong>
                <time
                  dateTime={reader.readAt}
                  title={new Date(reader.readAt).toLocaleString(undefined, {
                    dateStyle: 'full',
                    timeStyle: 'long',
                  })}
                >
                  {new Date(reader.readAt).toLocaleString(undefined, {
                    dateStyle: 'medium',
                    timeStyle: 'medium',
                  })}
                </time>
              </li>
            ))}
          </ul>
          {!loading && !error && !readers.length && (
            <p className="receipt-empty">No readers yet.</p>
          )}
          {cursor && (
            <button
              className="history-page-button"
              disabled={loading}
              onClick={() => void fetchPage(cursor)}
            >
              {loading ? 'Loading…' : 'More readers'}
            </button>
          )}
        </>
      )}
      {loading && !message.deletedAt && <p role="status">Loading readers…</p>}
      {error && !message.deletedAt && (
        <div className="form-error" role="alert">
          {error}
          <button className="text-button" onClick={() => void fetchPage(cursor ?? undefined)}>
            Try again
          </button>
        </div>
      )}
    </section>
  )
}
