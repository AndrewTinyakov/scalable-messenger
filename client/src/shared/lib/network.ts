export function isNetworkOnline(): boolean {
  return typeof window === 'undefined' || window.navigator.onLine !== false
}

export function subscribeNetwork(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener('online', listener)
  window.addEventListener('offline', listener)
  return () => {
    window.removeEventListener('online', listener)
    window.removeEventListener('offline', listener)
  }
}
