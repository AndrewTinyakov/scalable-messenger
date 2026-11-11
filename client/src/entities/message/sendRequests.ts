import type { components } from '../../shared/api/generated/schema'
import { isDateTime, isId, isRecord } from '../../shared/lib/validation'
import { MAX_VISIBLE_MESSAGES } from './historyWindow'
import { advanceSend, type ForwardSource, type PendingSend, type SendState } from './model'

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
  const forward = [value.forwardFromChatId, value.forwardFromMessageId, value.forwardedFromUserId]
  if (
    forward.some((field) => field !== undefined) &&
    (!forward.every(isId) ||
      value.replyToMessageId !== undefined ||
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

type SendDispatch =
  | { phase: 'idle' }
  | { phase: 'throttled'; timer: ReturnType<typeof setTimeout> }
  | { phase: 'awaiting-result'; requestId: string }

type Reconciliation =
  | { phase: 'ready' | 'polling'; failures: number }
  | { phase: 'backoff'; failures: number; until: number }

export class SendRequests {
  private sends: PendingSend[]
  private outbound: string[] = []
  private dispatch: SendDispatch = { phase: 'idle' }

  private get active(): string | undefined {
    return this.dispatch.phase === 'awaiting-result' ? this.dispatch.requestId : undefined
  }

  private get timer(): ReturnType<typeof setTimeout> | undefined {
    return this.dispatch.phase === 'throttled' ? this.dispatch.timer : undefined
  }
  private awaitResult(requestId: string): void {
    clearTimeout(this.timer)
    this.dispatch = { phase: 'awaiting-result', requestId }
  }

  private confirmation?: ReturnType<typeof setTimeout>
  private confirmationAt = 0
  private confirmationDeadline = new Map<string, number>()
  private confirmationAttempts = new Map<string, number>()
  resolved?: (saved: SavedSend[]) => void

  private watch(requestId: string): void {
    clearTimeout(this.confirmation)
    if (!this.confirmationDeadline.has(requestId))
      this.confirmationDeadline.set(requestId, this.adapters.now() + 60000)
    this.confirmationAt = this.adapters.now() + 10000
    this.confirmation = setTimeout(() => {
      this.confirmation = undefined
      if (this.active !== requestId || !this.adapters.isConnected()) return
      void this.reconcile()
        .then((saved) => this.resolved?.(saved))
        .finally(() => {
          const current = this.sends.find((send) => send.requestId === requestId)
          if (
            this.active !== requestId ||
            !current ||
            current.status === 'retryable' ||
            !this.adapters.isConnected()
          )
            return
          if (this.adapters.now() >= (this.confirmationDeadline.get(requestId) ?? Infinity))
            this.advance(requestId, 'retryable', {
              reason: 'Confirmation is still pending. Try again to check and resend safely.',
            })
          else if (!this.confirmation) this.watch(requestId)
        })
    }, 10000)
  }

  private nextSendAt = 0
  private backoff = 0

  disconnected(): void {
    clearTimeout(this.confirmation)
    clearTimeout(this.timer)
    this.dispatch = { phase: 'idle' }
    this.outbound = []
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
      this.dispatch = {
        phase: 'throttled',
        timer: setTimeout(() => {
          this.dispatch = { phase: 'idle' }
          this.drain()
        }, delay),
      }
      return
    }
    const requestId = this.outbound.shift()
    if (!requestId) return
    const send = this.sends.find((item) => item.requestId === requestId)
    if (!send || send.status !== 'sending') {
      this.drain()
      return
    }
    this.awaitResult(requestId)
    this.watch(requestId)
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
    if (this.active === requestId) this.dispatch = { phase: 'idle' }
    this.outbound = this.outbound.filter((id) => id !== requestId)
    this.outbound.unshift(requestId)
    this.backoff = Math.min(this.backoff + 1, 6)
    this.nextSendAt =
      this.adapters.now() + Math.min(500 * 2 ** this.backoff, 30000) + Math.random() * 250
    if (this.dispatch.phase === 'throttled') {
      clearTimeout(this.dispatch.timer)
      this.dispatch = { phase: 'idle' }
    }
    this.drain()
  }

  private release(requestId: string): void {
    this.confirmationAttempts.delete(requestId)
    this.confirmationDeadline.delete(requestId)
    if (this.active === requestId) {
      clearTimeout(this.confirmation)
      this.dispatch = { phase: 'idle' }
      this.backoff = 0
    }
    this.outbound = this.outbound.filter((id) => id !== requestId)
    this.drain()
  }

  private reconciliation: Reconciliation = { phase: 'ready', failures: 0 }
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

  start(
    chatId: string,
    body: string,
    replyToMessageId?: string,
    forward?: ForwardSource,
  ): { ok: boolean; error?: string } {
    const trimmed = forward ? body : body.trim()
    if (!trimmed.trim() || [...trimmed].length > 4000) return { ok: false }
    if (forward && (replyToMessageId || chatId.startsWith('draft:'))) return { ok: false }
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
      ...(forward
        ? {
            forwardFromChatId: forward.chatId,
            forwardFromMessageId: forward.messageId,
            forwardedFromUserId: forward.authorId,
          }
        : {}),
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

  unknown(requestId: string): void {
    if (!this.sends.some((send) => send.requestId === requestId && this.unresolved(send))) return
    if (this.active && this.active !== requestId) return
    if (!this.active) this.awaitResult(requestId)
    this.watch(requestId)
  }

  retryable(requestId: string, reason: string): void {
    this.advance(requestId, 'retryable', { reason })
    this.release(requestId)
  }

  async reconcile(retryUnknown = false): Promise<SavedSend[]> {
    if (retryUnknown) this.retryUnknownIntent += 1
    const previous = this.reconciliation
    if (
      previous.phase === 'polling' ||
      (previous.phase === 'backoff' && this.adapters.now() < previous.until)
    )
      return []
    this.reconciliation = { phase: 'polling', failures: previous.failures }
    const retryIntent = this.retryUnknownIntent
    const shouldRetryUnknown = retryIntent > this.handledRetryUnknownIntent
    let retryHandled = this.adapters.isConnected()
    const saved: SavedSend[] = []
    try {
      const unresolved = this.sends.filter((send) => this.unresolved(send))
      if (shouldRetryUnknown && !this.active && unresolved.length && this.adapters.isConnected()) {
        this.awaitResult(unresolved[0].requestId)
        this.watch(unresolved[0].requestId)
      }
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
          } else {
            const latest = this.sends.find((item) => item.requestId === send.requestId)
            if (!latest || !this.unresolved(latest)) continue
            if (!this.active && send.status === 'queued' && !shouldRetryUnknown) {
              this.awaitResult(send.requestId)
              this.watch(send.requestId)
            }
            const overdue =
              this.active === send.requestId && this.adapters.now() >= this.confirmationAt
            if (
              (shouldRetryUnknown || overdue) &&
              (send.status !== 'retryable' || shouldRetryUnknown) &&
              this.adapters.isConnected()
            ) {
              const attempts = this.confirmationAttempts.get(send.requestId) ?? 0
              if (overdue && attempts >= 3) {
                this.advance(send.requestId, 'retryable', {
                  reason: 'Confirmation is still pending. Try again to check and resend safely.',
                })
                clearTimeout(this.confirmation)
              } else if (!this.active || this.active === send.requestId) {
                this.confirmationAttempts.set(send.requestId, attempts + 1)
                this.advance(send.requestId, 'sending', { reason: undefined })
                if (this.active === send.requestId || send.status === 'queued') {
                  this.awaitResult(send.requestId)
                  this.watch(send.requestId)
                  this.adapters.send(this.sends.find((item) => item.requestId === send.requestId)!)
                } else resends.push(send)
              } else if (this.active !== send.requestId && send.status === 'sending')
                resends.push(send)
            } else if (shouldRetryUnknown && send.status === 'retryable' && !this.active) {
              this.advance(send.requestId, 'sending', { reason: undefined })
              resends.push(send)
            } else if (
              shouldRetryUnknown &&
              send.status === 'sending' &&
              this.active !== send.requestId
            ) {
              resends.push(send)
            } else if (shouldRetryUnknown && !this.adapters.isConnected()) retryHandled = false
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
      this.reconciliation = { phase: 'ready', failures: 0 }
    } catch {
      const failures = previous.failures + 1
      this.reconciliation = {
        phase: 'backoff',
        failures,
        until: this.adapters.now() + Math.min(30000 * 2 ** (failures - 1), 120000),
      }
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
    this.confirmationAttempts.delete(requestId)
    this.confirmationDeadline.delete(requestId)
    if (this.active === requestId) {
      this.dispatch = { phase: 'idle' }
      this.outbound = this.outbound.filter((id) => id !== requestId)
      this.outbound.unshift(requestId)
    }
    this.advance(requestId, 'sending', { reason: undefined })
    this.enqueue(requestId)
    this.drain()
    return undefined
  }

  forget(chatId: string, recipientId?: string): void {
    this.commit(
      this.sends.filter(
        (send) => send.chatId !== chatId && (!recipientId || send.recipientId !== recipientId),
      ),
    )
    for (const requestId of this.confirmationDeadline.keys()) {
      if (!this.sends.some((send) => send.requestId === requestId)) {
        this.confirmationDeadline.delete(requestId)
        this.confirmationAttempts.delete(requestId)
      }
    }
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
    const next =
      previous.status === 'queued' && (status === 'retryable' || status === 'sending')
        ? { ...previous, ...extra, status }
        : advanceSend(previous, status, extra)
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
