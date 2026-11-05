import { useEffect, useState } from 'react'
import type { ConnectionState } from '../../shared/api/socketConnection'

interface Props {
  connection: ConnectionState
  networkOnline: boolean
  nextRetryAt: number | null
  onRetry(): void
}

function useSecondsUntil(target: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (target === null) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [target])
  return target === null ? 0 : Math.max(0, Math.ceil((target - now) / 1000))
}

export function ConnectionStatus({ connection, networkOnline, nextRetryAt, onRetry }: Props) {
  const seconds = useSecondsUntil(nextRetryAt)
  if (connection === 'connected' && networkOnline) return null
  const waiting = networkOnline && connection === 'offline' && seconds > 0
  const label = !networkOnline
    ? 'Waiting for network…'
    : waiting
      ? `Reconnecting in ${seconds} s`
      : 'Connecting…'
  return (
    <div className="connection-status" role="status">
      <span className="connection-spinner" aria-hidden="true" />
      <span>{label}</span>
      {waiting && (
        <button type="button" onClick={onRetry}>
          Try now
        </button>
      )}
    </div>
  )
}
