let context: AudioContext | null = null
let lastPlayedAt = 0

export function playNotificationSound(now = Date.now()) {
  if (now - lastPlayedAt < 800 || typeof AudioContext === 'undefined') return
  lastPlayedAt = now
  try {
    context ??= new AudioContext()
    if (context.state === 'suspended') void context.resume()
    const start = context.currentTime
    for (const [offset, frequency] of [
      [0, 880],
      [0.11, 1318.5],
    ]) {
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.value = frequency
      gain.gain.setValueAtTime(0.0001, start + offset)
      gain.gain.exponentialRampToValueAtTime(0.18, start + offset + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.32)
      oscillator.connect(gain).connect(context.destination)
      oscillator.start(start + offset)
      oscillator.stop(start + offset + 0.34)
    }
  } catch {}
}
