import type { SnapshotMetadata } from '../../entities/message/historySnapshot'
import { isRecord, isSequence } from '../lib/validation'

export const snapshotFields = [
  'snapshotSequence',
  'mutationRevision',
  'visibilityRevision',
  'clearedThroughSequence',
  'globalClearedThroughSequence',
]

export function decodeSnapshot(value: unknown): SnapshotMetadata {
  if (!isRecord(value) || snapshotFields.some((field) => !isSequence(value[field])))
    throw new Error('Invalid response from server')
  if (
    BigInt(String(value.clearedThroughSequence)) > BigInt(String(value.snapshotSequence)) ||
    BigInt(String(value.globalClearedThroughSequence)) > BigInt(String(value.snapshotSequence))
  )
    throw new Error('Invalid response from server')
  return Object.fromEntries(
    snapshotFields.map((field) => [field, value[field]]),
  ) as unknown as SnapshotMetadata
}
