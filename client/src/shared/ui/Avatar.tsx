import { UsersRound } from 'lucide-react'
import { colorIndex } from '../lib/color'

interface Props {
  seed: string
  name: string
  size?: number
  group?: boolean
  online?: boolean
  className?: string
}

function initials(name: string): string {
  return [...name.replace(/_/g, ' ').trim().split(/\s+/)]
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => [...part][0]?.toUpperCase() ?? '')
    .join('')
}

export function Avatar({ seed, name, size = 48, group = false, online, className = '' }: Props) {
  return (
    <span
      className={`avatar avatar-tone-${colorIndex(seed)} ${className}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
      aria-hidden="true"
    >
      {group ? <UsersRound size={Math.round(size * 0.46)} strokeWidth={2} /> : initials(name)}
      {online && <span className="avatar-online" />}
    </span>
  )
}
