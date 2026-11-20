import type { SnapshotMetadata } from './historySnapshot'
import { MAX_CATCH_UP_MESSAGES } from './historyWindow'
import { mergeMessages, type Message } from './model'

type RequestState =
  { phase: 'pending'; messages: Message[] } | { phase: 'overflowed' | 'cancelled' | 'completed' }

type Request = {
  chatId: string
  state: RequestState
  fence: { mutationSeq: string; memberSeq: string }
}

export class HistoryRequests {
  private readonly pending = new Set<Request>()
  private capacity?: { promise: Promise<void>; release(): void }
  private readonly revisions = new Map<string, { mutationSeq: string; memberSeq: string }>()

  observe(chatId: string, snapshot: Partial<SnapshotMetadata>): void {
    const current = this.revisions.get(chatId) ?? { mutationSeq: '0', memberSeq: '0' }
    this.revisions.set(chatId, {
      mutationSeq:
        BigInt(snapshot.mutationSeq ?? '0') > BigInt(current.mutationSeq)
          ? snapshot.mutationSeq!
          : current.mutationSeq,
      memberSeq:
        BigInt(snapshot.memberSeq ?? '0') > BigInt(current.memberSeq)
          ? snapshot.memberSeq!
          : current.memberSeq,
    })
    const observed = this.revisions.get(chatId)!
    for (const request of this.pending)
      if (request.chatId === chatId) {
        if (
          request.state.phase === 'pending' &&
          (BigInt(observed.mutationSeq) > BigInt(request.fence.mutationSeq) ||
            BigInt(observed.memberSeq) > BigInt(request.fence.memberSeq))
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
          mutationSeq:
            BigInt(observed.mutationSeq) > BigInt(request.fence.mutationSeq)
              ? observed.mutationSeq
              : request.fence.mutationSeq,
          memberSeq:
            BigInt(observed.memberSeq) > BigInt(request.fence.memberSeq)
              ? observed.memberSeq
              : request.fence.memberSeq,
        }
      }
    if (this.revisions.size > 101) this.revisions.delete(this.revisions.keys().next().value!)
  }

  accepts(chatId: string, snapshot: Partial<SnapshotMetadata>): boolean {
    const current = this.revisions.get(chatId)
    return (
      !current ||
      ((snapshot.mutationSeq === undefined ||
        BigInt(snapshot.mutationSeq) >= BigInt(current.mutationSeq)) &&
        (snapshot.memberSeq === undefined ||
          BigInt(snapshot.memberSeq) >= BigInt(current.memberSeq)))
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
        ...(this.revisions.get(chatId) ?? { mutationSeq: '0', memberSeq: '0' }),
      },
    }
    this.pending.add(request)
    try {
      const page = await fetch()
      if (
        request.state.phase === 'cancelled' ||
        !this.accepts(chatId, page) ||
        (page.mutationSeq !== undefined &&
          BigInt(page.mutationSeq) < BigInt(request.fence.mutationSeq)) ||
        (page.memberSeq !== undefined && BigInt(page.memberSeq) < BigInt(request.fence.memberSeq))
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
