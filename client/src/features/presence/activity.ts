import type { PresenceConfig } from '../../shared/api/socket'

export type Activity = { active: boolean; visible: boolean }

const INPUT_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll']

/**
 * Reports when this page becomes active or idle. A page is idle after it has
 * been hidden or unfocused for a while, or has had no input for a while.
 */
export function watchActivity(
  config: () => PresenceConfig,
  onChange: (activity: Activity) => void,
  onRelease: (released: boolean) => void,
  target: Window = window,
): () => void {
  const document = target.document
  let lastInput = Date.now()
  let away: ReturnType<typeof setTimeout> | undefined
  let idle: ReturnType<typeof setTimeout> | undefined
  let release: ReturnType<typeof setTimeout> | undefined
  let reported: Activity | undefined
  const visible = () => document.visibilityState === 'visible'
  const present = () => visible() && document.hasFocus()
  const report = (active: boolean) => {
    const next = { active, visible: visible() }
    if (reported?.active === next.active && reported.visible === next.visible) return
    reported = next
    onChange(next)
  }
  const evaluate = () => {
    clearTimeout(away)
    clearTimeout(idle)
    const settings = config()
    if (!present()) {
      away = setTimeout(() => report(false), settings.idleAfterHiddenMs)
      if (reported?.visible && !visible()) report(reported.active)
      return
    }
    const remaining = lastInput + settings.idleAfterInputMs - Date.now()
    if (remaining <= 0) return report(false)
    report(true)
    idle = setTimeout(evaluate, remaining)
  }
  const onFocus = () => {
    lastInput = Date.now()
    evaluate()
  }
  const onVisibility = () => {
    clearTimeout(release)
    if (visible()) lastInput = Date.now()
    if (visible()) onRelease(false)
    else release = setTimeout(() => onRelease(true), config().releaseAfterHiddenMs)
    evaluate()
  }
  const onInput = () => {
    const wasIdle = Date.now() - lastInput >= config().idleAfterInputMs
    lastInput = Date.now()
    if (wasIdle || !reported?.active) evaluate()
  }
  INPUT_EVENTS.forEach((name) =>
    target.addEventListener(name, onInput, { passive: true, capture: true }),
  )
  target.addEventListener('focus', onFocus)
  target.addEventListener('blur', evaluate)
  document.addEventListener('visibilitychange', onVisibility)
  evaluate()
  return () => {
    clearTimeout(away)
    clearTimeout(idle)
    clearTimeout(release)
    INPUT_EVENTS.forEach((name) => target.removeEventListener(name, onInput, { capture: true }))
    target.removeEventListener('focus', onFocus)
    target.removeEventListener('blur', evaluate)
    document.removeEventListener('visibilitychange', onVisibility)
  }
}
