export function isPageActive(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}

export function subscribePageActivity(listener: () => void): () => void {
  document.addEventListener('visibilitychange', listener)
  window.addEventListener('focus', listener)
  window.addEventListener('blur', listener)
  return () => {
    document.removeEventListener('visibilitychange', listener)
    window.removeEventListener('focus', listener)
    window.removeEventListener('blur', listener)
  }
}
