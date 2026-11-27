import type { PresenceConfig } from '../../shared/api/socket'

export type Activity = { active: boolean; visible: boolean }

const INPUT_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll']

/**
 * Reports when this page becomes active or idle, and when it has been hidden
 * long enough to pause delivery. A page is idle once it has been hidden or
 * unfocused for a while, or has had no input for a while, whichever comes
 * first. Focus and return to the page count as input.
 */
export function watchActivity(
  config: () => PresenceConfig,
  onChange: (activity: Activity) => void,
  onRelease: (released: boolean) => void,
  target: Window = window,
): () => void {
  const document = target.document
  let lastInput = Date.now()
  let awaySince: number | undefined
  let hiddenSince: number | undefined
  let idle: ReturnType<typeof setTimeout> | undefined
  let release: ReturnType<typeof setTimeout> | undefined
  let reported: Activity | undefined
  let released = false
  const visible = () => document.visibilityState === 'visible'
  const present = () => visible() && document.hasFocus()
  const report = (next: Activity) => {
    if (reported?.active === next.active && reported.visible === next.visible) return
    reported = next
    onChange(next)
  }
  const evaluate = () => {
    clearTimeout(idle)
    const settings = config()
    const now = Date.now()
    if (present()) awaySince = undefined
    else awaySince ??= now
    if (visible()) hiddenSince = undefined
    else hiddenSince ??= now
    const activeUntil = Math.min(
      lastInput + settings.idleAfterInputMs,
      (awaySince ?? Infinity) + settings.idleAfterHiddenMs,
    )
    const visibleUntil = (hiddenSince ?? Infinity) + settings.idleAfterHiddenMs
    report({ active: now < activeUntil, visible: now < visibleUntil })
    const next = Math.min(...[activeUntil, visibleUntil].filter((at) => at > now))
    if (next !== Infinity) idle = setTimeout(evaluate, next - now)
  }
  const setReleased = (next: boolean) => {
    if (next === released) return
    released = next
    onRelease(next)
  }
  const armRelease = () => {
    clearTimeout(release)
    if (visible()) setReleased(false)
    else release = setTimeout(() => setReleased(true), config().releaseAfterHiddenMs)
  }
  const onReturn = () => {
    if (present()) lastInput = Date.now()
    armRelease()
    evaluate()
  }
  const onInput = () => {
    lastInput = Date.now()
    if (!reported?.active) evaluate()
  }
  INPUT_EVENTS.forEach((name) =>
    target.addEventListener(name, onInput, { passive: true, capture: true }),
  )
  target.addEventListener('focus', onReturn)
  target.addEventListener('blur', evaluate)
  document.addEventListener('visibilitychange', onReturn)
  armRelease()
  evaluate()
  return () => {
    clearTimeout(idle)
    clearTimeout(release)
    INPUT_EVENTS.forEach((name) => target.removeEventListener(name, onInput, { capture: true }))
    target.removeEventListener('focus', onReturn)
    target.removeEventListener('blur', evaluate)
    document.removeEventListener('visibilitychange', onReturn)
  }
}
