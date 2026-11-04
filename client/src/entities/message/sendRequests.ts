import type { components } from '../../shared/api/generated/schema'
import { isDateTime, isId, isRecord } from '../../shared/lib/validation'
import { MAX_VISIBLE_MESSAGES } from './historyWindow'
import { advanceSend, type PendingSend, type SendState } from './model'

export type SendResult = components['schemas']['SendStatusResponse']

export interface SavedSend {
  chatId: string
  draftChatId?: string
}

export interface SendRequestAdapters {
  storage: Pick<Storage, 'getItem' | 'setItem'>
  statuses(requestIds: string[]): Promise<{ requestId: string; result: SendResult }[]>
  status(requestId: string): Promise<SendResult>
  send(send: PendingSend): void
  isConnected(): boolean
  createId(): string
  now(): number
  onChange(sends: PendingSend[]): void
  pause?(milliseconds: number): Promise<void>
}

const MAX_REJECTED_SENDS = 100
const MAX_UNRESOLVED_SENDS = 256
const SEND_STATUS_BATCH_SIZE = 100
const sendStates = new Set(['sending', 'retryable', 'queued', 'saved', 'rejected'])

function isStoredSend(value: unknown): value is PendingSend {
  if (!isRecord(value)) return false
  const validChat =
    isId(value.chatId) ||
    (typeof value.chatId === 'string' &&
      value.chatId.startsWith('draft:') &&
      isId(value.chatId.slice(6)))
  if (
    !validChat ||
    !isId(value.requestId) ||
    typeof value.body !== 'string' ||
    !value.body.trim() ||
    [...value.body].length > 4000 ||
    !isDateTime(value.createdAt) ||
    typeof value.status !== 'string' ||
    !sendStates.has(value.status)
  )
    return false
  if (
    value.replyToMessageId !== undefined &&
    (!isId(value.replyToMessageId) ||
      (typeof value.chatId === 'string' && value.chatId.startsWith('draft:')))
  )
    return false
  if (value.reason !== undefined && typeof value.reason !== 'string') return false
  if (value.messageId !== undefined && !isId(value.messageId)) return false
  return (
    typeof value.chatId === 'string' &&
    (value.chatId.startsWith('draft:')
      ? isId(value.recipientId) && value.chatId === `draft:${value.recipientId}`
      : value.recipientId === undefined)
  )
}

function retain(sends: PendingSend[]): PendingSend[] {
  const saved = new Set(
    sends
      .filter((send) => send.status === 'saved')
      .slice(-MAX_VISIBLE_MESSAGES)
      .map((send) => send.requestId),
  )
  const rejected = new Set(
    sends
      .filter((send) => send.status === 'rejected')
      .slice(-MAX_REJECTED_SENDS)
      .map((send) => send.requestId),
  )
  return sends.filter(
    (send) =>
      (send.status !== 'saved' || saved.has(send.requestId)) &&
      (send.status !== 'rejected' || rejected.has(send.requestId)),
  )
}

function readStored(storage: Pick<Storage, 'getItem'>, key: string): PendingSend[] {
  try {
    const value = storage.getItem(key)
    const parsed: unknown = value ? JSON.parse(value) : []
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    let unresolved = 0
    return retain(
      parsed.filter(isStoredSend).filter((send) => {
        if (send.status === 'saved') return false
        if (seen.has(send.requestId)) return false
        if (send.status !== 'rejected' && ++unresolved > MAX_UNRESOLVED_SENDS) return false
        seen.add(send.requestId)
        return true
      }),
    )
  } catch {
    return []
  }
}

export class SendRequests {
  private sends: PendingSend[]
  private outbound: string[] = []
  private active?: string
  private timer?: ReturnType<typeof setTimeout>
  private nextSendAt = 0
  private backoff = 0

  disconnected(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.outbound = []
    this.active = undefined
  }

  private enqueue(requestId: string): void {
    if (this.active === requestId || this.outbound.includes(requestId)) return
    this.outbound.push(requestId)
    this.drain()
  }

  private drain(): void {
    if (this.active || this.timer || !this.adapters.isConnected()) return
    const delay = this.nextSendAt - this.adapters.now()
    if (delay > 0) {
      this.timer = setTimeout(() => {
        this.timer = undefined
        this.drain()
      }, delay)
      return
    }
    const requestId = this.outbound.shift()
    if (!requestId) return
    const send = this.sends.find((item) => item.requestId === requestId)
    if (!send || send.status !== 'sending') {
      this.drain()
      return
    }
    this.active = requestId
    this.nextSendAt = this.adapters.now() + 75
    try {
      this.adapters.send(send)
      if (!this.adapters.isConnected()) this.disconnected()
    } catch {
      this.disconnected()
    }
  }

  transient(requestId: string): void {
    if (!this.sends.some((send) => send.requestId === requestId && send.status === 'sending'))
      return
    if (this.active === requestId) this.active = undefined
    this.outbound = this.outbound.filter((id) => id !== requestId)
    this.outbound.unshift(requestId)
    this.backoff = Math.min(this.backoff + 1, 6)
    this.nextSendAt =
      this.adapters.now() + Math.min(500 * 2 ** this.backoff, 30000) + Math.random() * 250
    clearTimeout(this.timer)
    this.timer = undefined
    this.drain()
  }

  private release(requestId: string): void {
    if (this.active === requestId) {
      this.active = undefined
      this.backoff = 0
    }
    this.outbound = this.outbound.filter((id) => id !== requestId)
    this.drain()
  }

  private reconciling = false
  private pollFailures = 0
  private nextPollAt = 0
  private retryUnknownIntent = 0
  private handledRetryUnknownIntent = 0
  private readonly key: string

  constructor(
    prefix: string,
    private readonly adapters: SendRequestAdapters,
  ) {
    this.key = `${prefix}.pending`
    this.sends = readStored(adapters.storage, this.key)
    this.persist()
  }

  list(): PendingSend[] {
    return [...this.sends]
  }

  start(chatId: string, body: string, replyToMessageId?: string): { ok: boolean; error?: string } {
    const trimmed = body.trim()
    if (!trimmed || [...trimmed].length > 4000) return { ok: false }
    if (this.sends.filter((send) => this.unresolved(send)).length >= MAX_UNRESOLVED_SENDS) {
      return { ok: false }
    }
    const recipientId = chatId.startsWith('draft:') ? chatId.slice(6) : undefined
    const send: PendingSend = {
      chatId,
      recipientId,
      requestId: this.adapters.createId(),
      body: trimmed,
      ...(replyToMessageId ? { replyToMessageId } : {}),
      createdAt: new Date(this.adapters.now()).toISOString(),
      status: 'sending',
    }
    this.commit([...this.sends, send])
    this.enqueue(send.requestId)
    return { ok: true }
  }

  queued(requestId: string): void {
    this.advance(requestId, 'queued')
  }

  saved(
    requestId: string,
    chatId: string,
    messageId: string,
    sequence?: string,
  ): SavedSend | undefined {
    const send = this.sends.find((item) => item.requestId === requestId)
    if (!send || send.status === 'saved' || send.status === 'rejected') return undefined
    this.advance(requestId, 'saved', { chatId, messageId, sequence })
    this.release(requestId)
    return { chatId, ...(send.recipientId ? { draftChatId: send.chatId } : {}) }
  }

  rejected(requestId: string, reason?: string): void {
    this.advance(requestId, 'rejected', { reason: reason || 'The message could not be saved.' })
    this.release(requestId)
  }

  retryable(requestId: string, reason: string): void {
    this.advance(requestId, 'retryable', { reason })
    this.release(requestId)
  }

  async reconcile(retryUnknown = false): Promise<SavedSend[]> {
    if (retryUnknown) this.retryUnknownIntent += 1
    if (this.reconciling || this.adapters.now() < this.nextPollAt) return []
    this.reconciling = true
    const retryIntent = this.retryUnknownIntent
    const shouldRetryUnknown = retryIntent > this.handledRetryUnknownIntent
    let retryHandled = this.adapters.isConnected()
    const saved: SavedSend[] = []
    try {
      const unresolved = this.sends.filter((send) => this.unresolved(send))
      for (let offset = 0; offset < unresolved.length; offset += SEND_STATUS_BATCH_SIZE) {
        const batch = unresolved.slice(offset, offset + SEND_STATUS_BATCH_SIZE)
        const results = await this.adapters.statuses(batch.map((send) => send.requestId))
        const byId = new Map(results.map((entry) => [entry.requestId, entry.result]))
        const resends: PendingSend[] = []
        for (const send of batch) {
          const result = byId.get(send.requestId)
          if (!result) throw new Error('Send status response is incomplete')
          if (result.status === 'SAVED') {
            if (!result.messageId || !result.chatId)
              throw new Error('Saved status is missing message details')
            const outcome = this.saved(
              send.requestId,
              result.chatId,
              result.messageId,
              result.sequence ?? undefined,
            )
            if (outcome) saved.push(outcome)
          } else if (result.status === 'REJECTED') {
            this.rejected(send.requestId, result.reason || undefined)
          } else if (send.status === 'queued' && !this.active) {
            this.active = send.requestId
          } else if (
            shouldRetryUnknown &&
            (send.status === 'sending' || send.status === 'retryable')
          ) {
            const current = this.sends.find((item) => item.requestId === send.requestId)
            if (current && (current.status === 'sending' || current.status === 'retryable')) {
              if (this.adapters.isConnected()) {
                this.advance(send.requestId, 'sending', { reason: undefined })
                resends.push(current)
              } else {
                retryHandled = false
              }
            }
          }
        }
        for (const send of resends) {
          const current = this.sends.find((item) => item.requestId === send.requestId)
          if (!this.adapters.isConnected()) {
            retryHandled = false
            break
          }
          if (!current || (current.status !== 'sending' && current.status !== 'retryable')) continue
          this.enqueue(current.requestId)
        }
      }
      if (shouldRetryUnknown && retryHandled && this.adapters.isConnected())
        this.handledRetryUnknownIntent = retryIntent
      this.pollFailures = 0
      this.nextPollAt = 0
    } catch {
      this.pollFailures += 1
      this.nextPollAt = this.adapters.now() + Math.min(30000 * 2 ** (this.pollFailures - 1), 120000)
    } finally {
      this.reconciling = false
    }
    return saved
  }

  async retry(requestId: string): Promise<SavedSend | undefined> {
    const send = this.sends.find((item) => item.requestId === requestId)
    if (!send || send.status !== 'retryable' || !this.adapters.isConnected()) return undefined
    const result = await this.adapters.status(requestId)
    if (result.status === 'SAVED') {
      if (!result.messageId || !result.chatId)
        throw new Error('Saved status is missing message details')
      return this.saved(requestId, result.chatId, result.messageId, result.sequence ?? undefined)
    }
    if (result.status === 'REJECTED') {
      this.rejected(requestId, result.reason || undefined)
      return undefined
    }
    const current = this.sends.find((item) => item.requestId === requestId)
    if (!current || current.status !== 'retryable' || !this.adapters.isConnected()) return undefined
    this.advance(requestId, 'sending', { reason: undefined })
    this.enqueue(requestId)
    return undefined
  }

  forget(chatId: string, recipientId?: string): void {
    this.commit(
      this.sends.filter(
        (send) => send.chatId !== chatId && (!recipientId || send.recipientId !== recipientId),
      ),
    )
    if (this.active && !this.sends.some((send) => send.requestId === this.active))
      this.release(this.active)
  }

  revised(messageId: string): void {
    if (this.sends.some((send) => send.messageId === messageId))
      this.commit(this.sends.filter((send) => send.messageId !== messageId))
  }

  private unresolved(send: PendingSend): boolean {
    return send.status === 'sending' || send.status === 'retryable' || send.status === 'queued'
  }

  private advance(requestId: string, status: SendState, extra: Partial<PendingSend> = {}): void {
    const previous = this.sends.find((send) => send.requestId === requestId)
    if (!previous || previous.status === 'saved' || previous.status === 'rejected') return
    if (
      previous.status === status &&
      Object.keys(extra).every(
        (key) => previous[key as keyof PendingSend] === extra[key as keyof PendingSend],
      )
    )
      return
    const next = advanceSend(previous, status, extra)
    if (next === previous) return
    this.commit(this.sends.map((send) => (send.requestId === requestId ? next : send)))
  }

  private commit(sends: PendingSend[]): void {
    this.sends = retain(sends)
    this.persist()
    this.adapters.onChange(this.list())
  }

  private persist(): void {
    try {
      this.adapters.storage.setItem(
        this.key,
        JSON.stringify(this.sends.filter((send) => send.status !== 'saved')),
      )
    } catch {}
  }
}
