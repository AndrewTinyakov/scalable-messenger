import type { Message } from '../../entities/message/model'

interface Adapters {
  changes(
    chatId: string,
    after: string,
  ): Promise<{
    changes: { revision: string; message: Message }[]
    lastRevision: string
    nextRevision: string
    resetRequired: boolean
  }>
  reset(chatId: string): Promise<string>
  patch(chatId: string, messages: Message[]): void
}

export class MutationRecovery {
  private chatId: string | null = null
  private revision: string | undefined
  private generation = 0
  private running: Promise<void> | null = null

  constructor(private readonly adapters: Adapters) {}

  select(chatId: string | null): void {
    if (this.chatId === chatId) return
    this.chatId = chatId
    this.revision = undefined
    this.generation += 1
    this.running = null
  }

  snapshot(chatId: string, revision: string): void {
    if (chatId === this.chatId && this.revision === undefined) this.revision = revision
  }

  refresh(): Promise<void> {
    if (this.running) return this.running
    const chatId = this.chatId
    const generation = this.generation
    if (!chatId || this.revision === undefined) return Promise.resolve()
    const valid = () => generation === this.generation && chatId === this.chatId
    const run = async () => {
      for (let page = 0; page < 10 && valid(); page += 1) {
        const changes = await this.adapters.changes(chatId, this.revision!)
        if (!valid()) return
        if (changes.resetRequired || page === 9) {
          const revision = await this.adapters.reset(chatId)
          if (valid()) this.revision = revision
          return
        }
        this.adapters.patch(
          chatId,
          changes.changes.map((change) => change.message),
        )
        if (BigInt(changes.nextRevision) < BigInt(this.revision!))
          throw new Error('Message changes cursor moved backwards')
        if (
          changes.nextRevision === this.revision &&
          BigInt(changes.lastRevision) > BigInt(changes.nextRevision)
        )
          throw new Error('Message changes cursor did not advance')
        this.revision = changes.nextRevision
        if (BigInt(this.revision) >= BigInt(changes.lastRevision)) return
      }
    }
    const promise = run().finally(() => {
      if (this.running === promise) this.running = null
    })
    this.running = promise
    return promise
  }
}
