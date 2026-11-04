import type { SnapshotMetadata } from './historySnapshot'
import { MAX_CATCH_UP_MESSAGES } from './historyWindow'
import { mergeMessages, type Message } from './model'

type Request = {
  chatId: string
  messages: Message[]
  cancelled: boolean
  overflow: boolean
  fence: { mutationRevision: string; visibilityRevision: string }
}

export class HistoryRequests {
  private readonly pending = new Set<Request>()
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
          BigInt(observed.mutationRevision) > BigInt(request.fence.mutationRevision) ||
          BigInt(observed.visibilityRevision) > BigInt(request.fence.visibilityRevision)
        )
          request.messages = request.messages.map((message) =>
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

  async run<T extends { messages?: Message[] } & Partial<SnapshotMetadata>, R>(
    chatId: string,
    fetch: () => Promise<T>,
    install: (page: T) => R,
  ): Promise<R | undefined> {
    if (this.pending.size >= 16) throw new Error('Too many pending history requests')
    const request: Request = {
      chatId,
      messages: [],
      cancelled: false,
      overflow: false,
      fence: {
        ...(this.revisions.get(chatId) ?? { mutationRevision: '0', visibilityRevision: '0' }),
      },
    }
    this.pending.add(request)
    try {
      const page = await fetch()
      if (
        request.cancelled ||
        !this.accepts(chatId, page) ||
        (page.mutationRevision !== undefined &&
          BigInt(page.mutationRevision) < BigInt(request.fence.mutationRevision)) ||
        (page.visibilityRevision !== undefined &&
          BigInt(page.visibilityRevision) < BigInt(request.fence.visibilityRevision))
      )
        return undefined
      if (request.overflow) throw new Error('History changed too much while loading. Try again.')
      this.observe(chatId, page)
      return install(
        page.messages ? { ...page, messages: this.merge(page.messages, request.messages) } : page,
      )
    } finally {
      this.pending.delete(request)
      request.messages = []
    }
  }

  patch(chatId: string, messages: Message[]): void {
    for (const request of this.pending) {
      if (request.chatId !== chatId || request.overflow) continue
      const merged = mergeMessages(request.messages, messages)
      if (merged.length > MAX_CATCH_UP_MESSAGES) {
        request.overflow = true
        request.messages = []
      } else request.messages = merged
    }
  }

  protectLive(message: Message): Message | undefined {
    let protectedMessage = message
    for (const request of this.pending) {
      if (request.chatId !== message.chatId) continue
      if (request.overflow) return undefined
      protectedMessage = this.merge([protectedMessage], request.messages)[0]
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
      request.cancelled = true
      request.messages = []
      this.pending.delete(request)
    }
  }
}
