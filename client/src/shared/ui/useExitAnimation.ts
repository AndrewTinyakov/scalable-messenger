import { useLayoutEffect, useRef, type RefObject } from 'react'

export type ExitAnimation = (ghost: HTMLElement) => Animation

export const fadeOutMenu: ExitAnimation = (ghost) =>
  ghost.animate(
    [
      { opacity: 1, transform: 'scale(1)' },
      { opacity: 0, transform: 'scale(0.96)' },
    ],
    { duration: 120, easing: 'ease-in', fill: 'forwards' },
  )

export const fadeOutDialog: ExitAnimation = (ghost) => {
  ghost
    .querySelector('[role="dialog"]')
    ?.animate([{ transform: 'none' }, { transform: 'translateY(8px) scale(0.97)' }], {
      duration: 160,
      easing: 'ease-in',
      fill: 'forwards',
    })
  return ghost.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: 160,
    easing: 'ease-in',
    fill: 'forwards',
  })
}

export function useExitAnimation(ref: RefObject<HTMLElement>, exit: ExitAnimation) {
  const frame = useRef<number>()
  useLayoutEffect(() => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current)
    const node = ref.current
    return () => {
      if (!node || typeof node.animate !== 'function' || document.hidden) return
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
      frame.current = requestAnimationFrame(() => {
        frame.current = undefined
        if (node.isConnected) return
        const ghost = node.cloneNode(true) as HTMLElement
        ghost.classList.add('exit-ghost')
        ghost.setAttribute('aria-hidden', 'true')
        ghost.inert = true
        for (const element of [ghost, ...ghost.querySelectorAll('[id], [name]')]) {
          element.removeAttribute('id')
          element.removeAttribute('name')
        }
        document.body.append(ghost)
        const remove = () => ghost.remove()
        exit(ghost).finished.then(remove, remove)
      })
    }
  }, [ref, exit])
}
