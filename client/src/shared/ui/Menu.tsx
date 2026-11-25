import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { fadeOutMenu, useExitAnimation } from './useExitAnimation'

const EDGE = 8
const GAP = 6

export interface MenuPoint {
  x: number
  y: number
}

interface Props {
  label: string
  anchor: HTMLElement
  point?: MenuPoint
  align?: 'start' | 'end'
  keyboard?: boolean
  footer?: ReactNode
  onClose(): void
  children: ReactNode
}

function clamp(value: number, size: number, limit: number): number {
  return Math.max(EDGE, Math.min(value, limit - size - EDGE))
}

function swallowNextClick() {
  const swallow = (event: Event) => {
    event.preventDefault()
    event.stopPropagation()
    release()
  }
  const release = () => {
    document.removeEventListener('click', swallow, true)
    document.removeEventListener('pointerdown', release, true)
    document.removeEventListener('keydown', release, true)
  }
  document.addEventListener('click', swallow, true)
  document.addEventListener('pointerdown', release, true)
  document.addEventListener('keydown', release, true)
}

function placement(
  size: { width: number; height: number },
  anchor: DOMRect,
  point: MenuPoint | undefined,
  align: 'start' | 'end',
) {
  const width = window.innerWidth
  const height = window.innerHeight
  if (point) {
    const flipX = point.x + size.width > width - EDGE
    const flipY = point.y + size.height > height - EDGE
    return {
      left: clamp(flipX ? point.x - size.width : point.x, size.width, width),
      top: clamp(flipY ? point.y - size.height : point.y, size.height, height),
      origin: `${flipY ? 'bottom' : 'top'} ${flipX ? 'right' : 'left'}`,
    }
  }
  const below = anchor.bottom + GAP + size.height <= height - EDGE
  const left = align === 'end' ? anchor.right - size.width : anchor.left
  return {
    left: clamp(left, size.width, width),
    top: clamp(below ? anchor.bottom + GAP : anchor.top - size.height - GAP, size.height, height),
    origin: `${below ? 'top' : 'bottom'} ${align === 'end' ? 'right' : 'left'}`,
  }
}

export function Menu({
  label,
  anchor,
  point,
  align = 'start',
  keyboard = false,
  footer,
  onClose,
  children,
}: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ top: 0, left: 0, origin: 'top left' })
  const close = useRef(onClose)
  useExitAnimation(ref, fadeOutMenu)
  close.current = onClose
  const x = point?.x
  const y = point?.y

  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    const place = () =>
      setPosition(
        placement(
          { width: menu.offsetWidth, height: menu.offsetHeight },
          anchor.getBoundingClientRect(),
          x === undefined || y === undefined ? undefined : { x, y },
          align,
        ),
      )
    place()
    const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null
    resize?.observe(menu)
    window.addEventListener('resize', place)
    if (keyboard) menu.querySelector<HTMLElement>('[role^="menuitem"]')?.focus()
    return () => {
      resize?.disconnect()
      window.removeEventListener('resize', place)
    }
  }, [anchor, x, y, align, keyboard])

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (ref.current?.contains(event.target as Node)) return
      event.preventDefault()
      event.stopPropagation()
      if (event.button === 0) swallowNextClick()
      close.current()
    }
    const scroll = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) close.current()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      close.current()
    }
    document.addEventListener('pointerdown', dismiss, true)
    document.addEventListener('scroll', scroll, true)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', dismiss, true)
      document.removeEventListener('scroll', scroll, true)
      document.removeEventListener('keydown', escape, true)
    }
  }, [])

  return createPortal(
    <div
      ref={ref}
      className="menu"
      style={{ top: position.top, left: position.left, transformOrigin: position.origin }}
      onContextMenu={(event) => event.preventDefault()}
      onPointerMove={(event) => {
        const item = (event.target as HTMLElement).closest<HTMLElement>('[role^="menuitem"]')
        if (
          item &&
          item !== document.activeElement &&
          ref.current?.contains(document.activeElement)
        )
          item.focus({ preventScroll: true })
      }}
      onKeyDown={(event) => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])]
        const index = items.indexOf(document.activeElement as HTMLElement)
        if (index < 0) return
        event.preventDefault()
        items[
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
        ]?.focus()
      }}
    >
      <div role="menu" aria-label={label}>
        {children}
      </div>
      {footer}
    </div>,
    document.body,
  )
}

interface ItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ReactNode
  danger?: boolean
}

export function MenuItem({ icon, danger = false, children, className = '', ...rest }: ItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`menu-item ${danger ? 'danger-text' : ''} ${className}`}
      {...rest}
    >
      {icon}
      <span>{children}</span>
    </button>
  )
}
