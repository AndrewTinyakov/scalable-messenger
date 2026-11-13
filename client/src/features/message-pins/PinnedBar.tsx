import { ListFilter, PinOff } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { PinnedEntry } from './useMessagePins'

interface Props {
  pins: PinnedEntry[]
  total: number
  onJump(messageId: string): void
  onOpenList(): void
  onUnpin(entry: PinnedEntry): void
}

export function PinnedBar({ pins, total, onJump, onOpenList, onUnpin }: Props) {
  const [index, setIndex] = useState(0)
  const count = pins.length
  useEffect(() => {
    setIndex((current) => (current < count ? current : 0))
  }, [count])
  const current = pins[Math.min(index, count - 1)]
  if (!current) return null
  const preview = current.message.body.replace(/\s+/g, ' ')
  return (
    <div className="pinned-bar">
      <button
        className="pinned-bar-main"
        onClick={() => {
          onJump(current.message.id)
          setIndex((value) => (value + 1) % count)
        }}
        aria-label={`Pinned message ${index + 1} of ${total}: ${preview}`}
      >
        <span className="pinned-bar-copy" key={current.message.id}>
          <strong>
            {total > 1 && index > 0 ? `Pinned message #${total - index}` : 'Pinned message'}
          </strong>
          <span>{preview}</span>
        </span>
      </button>
      {total > 1 ? (
        <button
          className="icon-button"
          onClick={onOpenList}
          aria-label={`Show all ${total} pinned messages`}
        >
          <ListFilter size={20} />
        </button>
      ) : (
        <button className="icon-button" onClick={() => onUnpin(current)} aria-label="Unpin message">
          <PinOff size={19} />
        </button>
      )}
    </div>
  )
}
