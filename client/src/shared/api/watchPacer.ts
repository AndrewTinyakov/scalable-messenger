import type { OutgoingSocketFrame } from './socket'

export class WatchPacer {
  private pending = new Map<string, OutgoingSocketFrame>()
  private nextAt = 0
  private timer?: ReturnType<typeof setTimeout>

  constructor(private readonly send: (frame: OutgoingSocketFrame) => void) {}

  offer(frame: OutgoingSocketFrame): void {
    this.pending.set(frame.type, frame)
    this.flush()
  }

  reset(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.pending.clear()
  }

  private flush(): void {
    if (this.timer || !this.pending.size) return
    const delay = this.nextAt - Date.now()
    if (delay > 0) {
      this.timer = setTimeout(() => {
        this.timer = undefined
        this.flush()
      }, delay)
      return
    }
    const [key, frame] = this.pending.entries().next().value!
    this.pending.delete(key)
    this.nextAt = Date.now() + 1500
    this.send(frame)
    this.flush()
  }
}
