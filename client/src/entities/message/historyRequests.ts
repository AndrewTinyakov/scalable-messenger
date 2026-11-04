import { MAX_CATCH_UP_MESSAGES } from './historyWindow'
import { mergeMessages, type Message } from './model'

type Request = {
  chatId: string
  messages: Message[]
  cancelled: boolean
  overflow: boolean
}

export class HistoryRequests {
  private readonly pending = new Set<Request>()

  async run<T extends { messages: Message[] }, R>(
    chatId: string,
    fetch: () => Promise<T>,
    install: (page: T) => R,
  ): Promise<R | undefined> {
    if (this.pending.size >= 16) throw new Error('Too many pending history requests')
    const request: Request = { chatId, messages: [], cancelled: false, overflow: false }
    this.pending.add(request)
    try {
      const page = await fetch()
      if (request.cancelled) return undefined
      if (request.overflow) throw new Error('History changed too much while loading. Try again.')
      return install({ ...page, messages: this.merge(page.messages, request.messages) })
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
    const ids = new Set(messages.map((message) => message.id))
    return mergeMessages(messages, mutations).filter((message) => ids.has(message.id))
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
