import type { ChatKind, OutgoingSocketFrame } from '../../shared/api/socket'
import type { Message } from './model'

export interface RecoveryHistory {
  latest(chatId: string): Promise<{ messages: Message[] }>
  after(
    chatId: string,
    sequence: string,
  ): Promise<{ messages: Message[]; hasMore: boolean; nextSequence: string }>
  older(chatId: string, sequence: string): Promise<{ messages: Message[] }>
}

export interface RecoveryRuntime {
  history: RecoveryHistory
  context(chatId: string): {
    selected: boolean
    readingHistory: boolean
    removed: boolean
    connected: boolean
    room: string
    kind?: ChatKind
  }
  changed(): void
  sendFrame(frame: OutgoingSocketFrame | null): void
  jumped(): void
  failed(message: string): void
  recovered(message: string): void
}
