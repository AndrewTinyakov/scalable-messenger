import type { SnapshotMetadata } from './historySnapshot'

export type HistoryBounds = {
  older?: string
  newer?: string
  hasOlder?: boolean
  hasNewer?: boolean
}
type Revisions = { mutationSeq: string; visibilitySeq: string }
type Entry = {
  snapshot: Partial<SnapshotMetadata>
  unverified: Set<string>
  bounds: HistoryBounds
  verified?: Revisions
}

export class HistoryVisibility {
  private readonly entries = new Map<string, Entry>()
  private selected: string | null = null

  constructor(private readonly evicted: (chatId: string) => void) {}

  select(chatId: string | null): void {
    this.selected = chatId
    if (chatId) this.touch(chatId)
  }

  private touch(chatId: string): Entry {
    const entry = this.entries.get(chatId) ?? {
      snapshot: {},
      unverified: new Set<string>(),
      bounds: {},
    }
    this.entries.delete(chatId)
    this.entries.set(chatId, entry)
    if (this.entries.size > 101) {
      const oldest = [...this.entries.keys()].find((id) => id !== this.selected)!
      this.entries.delete(oldest)
      this.evicted(oldest)
    }
    return entry
  }

  snapshot(chatId: string): Partial<SnapshotMetadata> {
    return this.entries.get(chatId)?.snapshot ?? {}
  }

  cutoff(chatId: string): bigint {
    const snapshot = this.snapshot(chatId)
    const personal = BigInt(snapshot.clearedThroughSequence ?? '0')
    const global = BigInt(snapshot.globalClearedThroughSequence ?? '0')
    return personal > global ? personal : global
  }

  observe(chatId: string, snapshot: Partial<SnapshotMetadata>, retainedIds: string[]): boolean {
    const entry = this.touch(chatId)
    const changed =
      BigInt(snapshot.visibilitySeq ?? '0') > BigInt(entry.snapshot.visibilitySeq ?? '0') ||
      BigInt(snapshot.mutationSeq ?? '0') > BigInt(entry.snapshot.mutationSeq ?? '0')
    if (changed) entry.unverified = new Set(retainedIds)
    for (const field of [
      'snapshotSequence',
      'mutationSeq',
      'visibilitySeq',
      'clearedThroughSequence',
      'globalClearedThroughSequence',
    ] as const)
      if (
        snapshot[field] !== undefined &&
        BigInt(snapshot[field]!) >= BigInt(entry.snapshot[field] ?? '0')
      )
        entry.snapshot[field] = snapshot[field]
    return changed
  }

  isUnverified(chatId: string, messageId: string): boolean {
    return this.entries.get(chatId)?.unverified.has(messageId) ?? false
  }

  resolved(chatId: string, ids: string[]): void {
    const unverified = this.entries.get(chatId)?.unverified
    for (const id of ids) unverified?.delete(id)
  }

  bounds(chatId: string): HistoryBounds {
    return this.entries.get(chatId)?.bounds ?? {}
  }

  setBounds(chatId: string, bounds: HistoryBounds): void {
    this.touch(chatId).bounds = bounds
  }

  verified(chatId: string): Revisions | undefined {
    return this.entries.get(chatId)?.verified
  }

  verify(chatId: string, revisions: Revisions): void {
    const entry = this.touch(chatId)
    entry.verified = {
      mutationSeq:
        BigInt(revisions.mutationSeq) > BigInt(entry.verified?.mutationSeq ?? '0')
          ? revisions.mutationSeq
          : (entry.verified?.mutationSeq ?? '0'),
      visibilitySeq:
        BigInt(revisions.visibilitySeq) > BigInt(entry.verified?.visibilitySeq ?? '0')
          ? revisions.visibilitySeq
          : (entry.verified?.visibilitySeq ?? '0'),
    }
  }

  forget(chatId: string): void {
    this.entries.delete(chatId)
    this.evicted(chatId)
  }
}
