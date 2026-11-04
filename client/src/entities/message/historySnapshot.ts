import type { Message } from './model'

export interface SnapshotMetadata {
  snapshotSequence: string
  mutationRevision: string
  visibilityRevision: string
  clearedThroughSequence: string
  globalClearedThroughSequence: string
}

export type HistorySnapshot = {
  messages: Message[]
  coverageAfterSequence?: string
  coverageThroughSequence?: string
  nextSequence?: string
  hasMore?: boolean
} & Partial<SnapshotMetadata>

export type VisibilitySnapshot = SnapshotMetadata & { hidden: boolean }
export type ResolvedMessages = SnapshotMetadata & { messages: Message[] }
export type DeleteScope = 'SELF' | 'EVERYONE'
export type DeleteTarget = 'MESSAGES' | 'HISTORY' | 'CHAT'
export interface DeletionResult {
  operationId: string
  scope: DeleteScope
  target: DeleteTarget
  clearedThroughSequence: string
  mutationRevision: string
  visibilityRevision: string
  state: 'ACCEPTED' | 'COMPLETED'
  deletedRows: string
}

export type MessageChange = {
  revision: string
  kind?: 'UPSERT' | 'REMOVED' | 'CLEARED'
  message: Message | null
  messageId?: string | null
  sequence?: string | null
  clearedThroughSequence?: string | null
}

export type ChangesSnapshot = Partial<SnapshotMetadata> & {
  changes: MessageChange[]
  lastRevision: string
  nextRevision: string
  resetRequired: boolean
}

export function hasCoverage(page: HistorySnapshot): page is HistorySnapshot & {
  coverageAfterSequence: string
  coverageThroughSequence: string
} {
  return page.coverageAfterSequence !== undefined && page.coverageThroughSequence !== undefined
}
