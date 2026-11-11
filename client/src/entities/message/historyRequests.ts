import type { SnapshotMetadata } from './historySnapshot'
import { MAX_CATCH_UP_MESSAGES } from './historyWindow'
import { mergeMessages, type Message } from './model'

type RequestState =
  { phase: 'pending'; messages: Message[] } | { phase: 'overflowed' | 'cancelled' | 'completed' }

type Request = {
  chatId: string
  state: RequestState
  fence: { mutationRevision: string; visibilityRevision: string }
}

export class HistoryRequests {
  private readonly pending = new Set<Request>()
  private capacity?: { promise: Promise<void>; release(): void }
  private readonly revisions = new Map<
    string,
    { mutationRevision: string; visibilityRevision: string }
  >()

  observe(chatId: string, snapshot: Partial<SnapshotMetadata>): void {
    const current = this.revisions.get(chatId) ?? { mutationRevision: '0', visibilityRevision: '0' }
    this.revisions.set(chatId, {
      mutationRevision:
        BigInt(snapshot.mutationRevision ?? '0') > BigInt(current.mutationRevision)
          ? snapshot.mutationRevision!
          : current.mutationRevision,
      visibilityRevision:
        BigInt(snapshot.visibilityRevision ?? '0') > BigInt(current.visibilityRevision)
          ? snapshot.visibilityRevision!
          : current.visibilityRevision,
    })
    const observed = this.revisions.get(chatId)!
    for (const request of this.pending)
      if (request.chatId === chatId) {
        if (
          request.state.phase === 'pending' &&
          (BigInt(observed.mutationRevision) > BigInt(request.fence.mutationRevision) ||
            BigInt(observed.visibilityRevision) > BigInt(request.fence.visibilityRevision))
        )
          request.state.messages = request.state.messages.map((message) =>
            message.replyToMessageId
              ? {
                  ...message,
                  replySenderId: null,
                  replyBody: null,
                  replyDeleted: null,
                  replyVersion: null,
                }
              : message,
          )
        request.fence = {
          mutationRevision:
            BigInt(observed.mutationRevision) > BigInt(request.fence.mutationRevision)
              ? observed.mutationRevision
              : request.fence.mutationRevision,
          visibilityRevision:
            BigInt(observed.visibilityRevision) > BigInt(request.fence.visibilityRevision)
              ? observed.visibilityRevision
              : request.fence.visibilityRevision,
        }
      }
    if (this.revisions.size > 101) this.revisions.delete(this.revisions.keys().next().value!)
  }

  accepts(chatId: string, snapshot: Partial<SnapshotMetadata>): boolean {
    const current = this.revisions.get(chatId)
    return (
      !current ||
      ((snapshot.mutationRevision === undefined ||
        BigInt(snapshot.mutationRevision) >= BigInt(current.mutationRevision)) &&
        (snapshot.visibilityRevision === undefined ||
          BigInt(snapshot.visibilityRevision) >= BigInt(current.visibilityRevision)))
    )
  }

  waitForCapacity(): Promise<void> | undefined {
    if (this.pending.size < 16) return undefined
    if (!this.capacity) {
      let release!: () => void
      const promise = new Promise<void>((resolve) => {
        release = resolve
      })
      this.capacity = { promise, release }
    }
    return this.capacity.promise
  }

  private releaseCapacity(): void {
    if (this.pending.size >= 16) return
    this.capacity?.release()
    this.capacity = undefined
  }

  async run<T extends { messages?: Message[] } & Partial<SnapshotMetadata>, R>(
    chatId: string,
    fetch: () => Promise<T>,
    install: (page: T) => R,
  ): Promise<R | undefined> {
    if (this.pending.size >= 16) return undefined
    const request: Request = {
      chatId,
      state: { phase: 'pending', messages: [] },
      fence: {
        ...(this.revisions.get(chatId) ?? { mutationRevision: '0', visibilityRevision: '0' }),
      },
    }
    this.pending.add(request)
    try {
      const page = await fetch()
      if (
        request.state.phase === 'cancelled' ||
        !this.accepts(chatId, page) ||
        (page.mutationRevision !== undefined &&
          BigInt(page.mutationRevision) < BigInt(request.fence.mutationRevision)) ||
        (page.visibilityRevision !== undefined &&
          BigInt(page.visibilityRevision) < BigInt(request.fence.visibilityRevision))
      )
        return undefined
      if (request.state.phase === 'overflowed')
        throw new Error('History changed too much while loading. Try again.')
      if (request.state.phase !== 'pending') return undefined
      this.observe(chatId, page)
      return install(
        page.messages
          ? { ...page, messages: this.merge(page.messages, request.state.messages) }
          : page,
      )
    } finally {
      this.pending.delete(request)
      this.releaseCapacity()
      request.state = { phase: 'completed' }
    }
  }

  patch(chatId: string, messages: Message[]): void {
    for (const request of this.pending) {
      if (request.chatId !== chatId || request.state.phase !== 'pending') continue
      const merged = mergeMessages(request.state.messages, messages)
      if (merged.length > MAX_CATCH_UP_MESSAGES) {
        request.state = { phase: 'overflowed' }
      } else request.state.messages = merged
    }
  }

  protectLive(message: Message): Message | undefined {
    let protectedMessage = message
    for (const request of this.pending) {
      if (request.chatId !== message.chatId) continue
      if (request.state.phase === 'overflowed') return undefined
      if (request.state.phase !== 'pending') continue
      protectedMessage = this.merge([protectedMessage], request.state.messages)[0]
    }
    return protectedMessage
  }

  private merge(messages: Message[], mutations: Message[]): Message[] {
    const authoritative = new Map(messages.map((message) => [message.id, message]))
    const overlays = mutations
      .filter((message) => authoritative.has(message.id))
      .map((message) => {
        const canonical = authoritative.get(message.id)!
        if (!message.replyToMessageId && !canonical.replyToMessageId) return message
        return {
          ...message,
          replyToMessageId: canonical.replyToMessageId ?? null,
          replySenderId: canonical.replySenderId ?? null,
          replyBody: canonical.replyBody ?? null,
          replyDeleted: canonical.replyDeleted ?? null,
          replyVersion: canonical.replyVersion ?? null,
        }
      })
    return mergeMessages(messages, overlays)
  }

  cancel(chatId?: string): void {
    for (const request of this.pending) {
      if (chatId !== undefined && request.chatId !== chatId) continue
      request.state = { phase: 'cancelled' }
      this.pending.delete(request)
    }
    this.releaseCapacity()
  }
}
