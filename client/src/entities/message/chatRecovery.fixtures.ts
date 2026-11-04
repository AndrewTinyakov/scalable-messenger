import type { OutgoingSocketFrame } from '../../shared/api/socket'
import { ChatRecovery, type RecoveryHistory } from './chatRecovery'
import type { Message } from './model'

export function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
  }
}

export function message(sequence: string): Message {
  return {
    id: `message-${sequence}`,
    chatId: 'chat',
    sequence,
    senderId: 'sender',
    body: sequence,
    createdAt: '2026-01-01T00:00:00Z',
  }
}

export function connectedRecovery(history: RecoveryHistory, storage = memoryStorage()) {
  const frames: OutgoingSocketFrame[] = []
  const recovery = new ChatRecovery('device', storage)
  let changes = 0
  recovery.configure({
    history,
    context: () => ({
      selected: true,
      readingHistory: false,
      removed: false,
      connected: true,
      room: 'group:chat',
      kind: 'GROUP',
    }),
    changed: () => {
      changes += 1
    },
    sendFrame: (frame) => {
      if (frame) frames.push(frame)
    },
    jumped: () => {},
    failed: () => {},
    recovered: () => {},
  })
  return { recovery, frames, changes: () => changes }
}

export function baselineStorage(sequence: string) {
  const storage = memoryStorage()
  storage.setItem('device.resolved-cursor.v2', JSON.stringify({ chat: sequence }))
  return storage
}
