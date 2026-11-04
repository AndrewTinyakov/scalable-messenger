import { FrameType } from '../../shared/api/generated/socket-vocabulary'
import type { RecoveryFrame } from '../../shared/api/socket'
import type { RecoveryRuntime } from './recoveryRuntime'

type AppliedFrame = Extract<RecoveryFrame, { type: typeof FrameType.APPLIED }>
const LIVE_FLUSH_INTERVAL = 25
const LIVE_ACK_BATCH_SIZE = 64

export class RecoveryBatch {
  private acknowledgements = new Map<
    string,
    { frame: AppliedFrame; canAcknowledge: () => boolean }
  >()
  private acknowledgementCount = 0
  private timer?: ReturnType<typeof setTimeout>
  private changed = false
  private pendingStorage = new Map<string, unknown>()

  constructor(
    private readonly storage: Pick<Storage, 'setItem'>,
    private readonly runtime: () => RecoveryRuntime,
    private readonly disposed: () => boolean,
  ) {}

  notify(): void {
    this.changed = true
    this.schedule()
  }

  acknowledge(frame: RecoveryFrame, canAcknowledge: () => boolean): void {
    if (frame.type !== FrameType.APPLIED) return
    this.acknowledgements.set(frame.chatId, { frame, canAcknowledge })
    this.acknowledgementCount += 1
    if (this.acknowledgementCount >= LIVE_ACK_BATCH_SIZE) this.flush()
    else this.schedule()
  }

  discard(chatId: string): void {
    this.acknowledgements.delete(chatId)
  }

  private schedule(): void {
    if (this.timer === undefined) this.timer = setTimeout(() => this.flush(), LIVE_FLUSH_INTERVAL)
  }

  flush(sendAcknowledgements = true): void {
    clearTimeout(this.timer)
    this.timer = undefined
    const acknowledgements = this.acknowledgements
    this.acknowledgements = new Map()
    this.acknowledgementCount = 0
    for (const [key, value] of this.pendingStorage) this.write(key, value)
    this.pendingStorage.clear()
    if (this.changed) {
      this.changed = false
      if (!this.disposed()) this.runtime().changed()
    }
    for (const { frame, canAcknowledge } of acknowledgements.values()) {
      if (sendAcknowledgements && canAcknowledge() && !this.runtime().context(frame.chatId).removed)
        this.runtime().sendFrame(frame)
    }
  }

  persist(key: string, value: unknown, batch = false): void {
    if (batch) {
      this.pendingStorage.set(key, value)
      this.schedule()
    } else {
      this.pendingStorage.delete(key)
      this.write(key, value)
    }
  }

  private write(key: string, value: unknown): void {
    try {
      this.storage.setItem(key, JSON.stringify(value))
    } catch {}
  }
}
