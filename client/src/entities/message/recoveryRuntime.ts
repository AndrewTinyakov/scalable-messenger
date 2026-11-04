import type { ChatKind, OutgoingSocketFrame } from '../../shared/api/socket'
import type { HistorySnapshot, ResolvedMessages, VisibilitySnapshot } from './historySnapshot'
import type { ReadingLocation } from './readingLocation'

export interface RecoveryHistory {
  latest(chatId: string): Promise<HistorySnapshot>
  after(
    chatId: string,
    sequence: string,
  ): Promise<HistorySnapshot & { hasMore: boolean; nextSequence: string }>
  older(chatId: string, sequence: string): Promise<HistorySnapshot>
  around?(
    chatId: string,
    messageId: string,
    anchorSequence: string,
  ): Promise<
    HistorySnapshot & { anchorMessageId: string | null; hasOlder: boolean; hasNewer: boolean }
  >
  visibility?(chatId: string): Promise<VisibilitySnapshot>
  resolve?(chatId: string, messageIds: string[]): Promise<ResolvedMessages>
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
  locationRestored?(chatId: string, location: ReadingLocation | undefined): void
  hidden?(chatId: string): void
}
