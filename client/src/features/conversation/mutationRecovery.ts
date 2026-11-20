import type {
  ChangesSnapshot,
  MessageChange,
  SnapshotMetadata,
} from '../../entities/message/historySnapshot'
import type { Message } from '../../entities/message/model'

interface Adapters {
  changes(chatId: string, after: string): Promise<ChangesSnapshot | undefined>
  reset(chatId: string): Promise<string>
  patch(chatId: string, messages: Message[]): void
  apply?(
    chatId: string,
    changes: MessageChange[],
    snapshot: Partial<SnapshotMetadata>,
  ): boolean | void
}

type MutationRecoveryState =
  | { phase: 'unselected' }
  | { phase: 'awaiting-snapshot'; chatId: string }
  | { phase: 'ready'; chatId: string; revision: string }
  | { phase: 'refreshing'; chatId: string; revision: string; promise: Promise<void> }

export class MutationRecovery {
  private state: MutationRecoveryState = { phase: 'unselected' }

  constructor(private readonly adapters: Adapters) {}

  select(chatId: string | null): void {
    if (chatId === ('chatId' in this.state ? this.state.chatId : null)) return
    this.state = chatId ? { phase: 'awaiting-snapshot', chatId } : { phase: 'unselected' }
  }

  snapshot(chatId: string, revision: string): void {
    if (this.state.phase === 'awaiting-snapshot' && chatId === this.state.chatId)
      this.state = { phase: 'ready', chatId, revision }
  }

  behind(chatId: string, mutationSeq: string): boolean {
    return (
      this.state.phase === 'ready' &&
      this.state.chatId === chatId &&
      BigInt(mutationSeq) > BigInt(this.state.revision)
    )
  }

  refresh(): Promise<void> {
    if (this.state.phase === 'refreshing') return this.state.promise
    if (this.state.phase !== 'ready') return Promise.resolve()
    const operation: Extract<MutationRecoveryState, { phase: 'refreshing' }> = {
      ...this.state,
      phase: 'refreshing',
      promise: Promise.resolve(),
    }
    this.state = operation
    const chatId = operation.chatId
    const valid = () => this.state === operation
    const run = async () => {
      for (let page = 0; page < 10 && valid(); page += 1) {
        const changes = await this.adapters.changes(chatId, operation.revision)
        if (!valid()) return
        if (!changes) continue
        if (changes.resetRequired) {
          const revision = await this.adapters.reset(chatId)
          if (valid()) operation.revision = revision
          return
        }
        if (BigInt(changes.nextSeq) < BigInt(operation.revision))
          throw new Error('Message changes cursor moved backwards')
        if (
          changes.nextSeq === operation.revision &&
          BigInt(changes.lastSeq) > BigInt(changes.nextSeq)
        )
          throw new Error('Message changes cursor did not advance')
        if (this.adapters.apply) {
          const applied = this.adapters.apply(chatId, changes.changes, {
            ...changes,
            mutationSeq: changes.lastSeq,
          })
          if (applied === false) continue
        } else
          this.adapters.patch(
            chatId,
            changes.changes.flatMap((change) => (change.message ? [change.message] : [])),
          )
        if (page === 9) {
          const revision = await this.adapters.reset(chatId)
          if (valid()) operation.revision = revision
          return
        }
        operation.revision = changes.nextSeq
        if (BigInt(operation.revision) >= BigInt(changes.lastSeq)) return
      }
    }
    operation.promise = run().finally(() => {
      if (valid()) this.state = { phase: 'ready', chatId, revision: operation.revision }
    })
    return operation.promise
  }
}
