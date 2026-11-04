import { isId, isRecord, isSequence } from '../../shared/lib/validation'

export interface ReadingLocation {
  messageId: string
  sequence: string
  offsetPx: number
  atLatest: boolean
}

export class ReadingLocations {
  private readonly values = new Map<string, ReadingLocation>()

  constructor(
    private readonly key: string,
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'>,
  ) {
    try {
      const saved: unknown = JSON.parse(storage.getItem(key) ?? '{}')
      if (isRecord(saved))
        for (const [chatId, location] of Object.entries(saved).slice(-100))
          if (isId(chatId) && this.valid(location)) this.values.set(chatId, location)
    } catch {}
  }

  private valid(value: unknown): value is ReadingLocation {
    return (
      isRecord(value) &&
      Object.keys(value).every((key) =>
        ['messageId', 'sequence', 'offsetPx', 'atLatest'].includes(key),
      ) &&
      typeof value.messageId === 'string' &&
      value.messageId.length > 0 &&
      value.messageId.length <= 128 &&
      isSequence(value.sequence) &&
      value.sequence !== '0' &&
      typeof value.offsetPx === 'number' &&
      Number.isFinite(value.offsetPx) &&
      Math.abs(value.offsetPx) <= 100000 &&
      typeof value.atLatest === 'boolean'
    )
  }

  get(chatId: string): ReadingLocation | undefined {
    const location = this.values.get(chatId)
    return location && { ...location }
  }

  remember(chatId: string, location: ReadingLocation): void {
    if (!this.valid(location)) return
    this.values.delete(chatId)
    this.values.set(chatId, { ...location })
    if (this.values.size > 100) this.values.delete(this.values.keys().next().value!)
    this.save()
  }

  forget(chatId: string): void {
    this.values.delete(chatId)
    this.save()
  }

  private save(): void {
    try {
      this.storage.setItem(this.key, JSON.stringify(Object.fromEntries(this.values)))
    } catch {}
  }
}
