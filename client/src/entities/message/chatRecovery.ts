import { ChatKind, FrameType } from '../../shared/api/generated/socket-vocabulary'
import type { RecoveryFrame } from '../../shared/api/socket'
import { reconnectDelay } from '../../shared/lib/reconnect'
import { HistoryRequests } from './historyRequests'
import { HISTORY_PAGE_SIZE, MAX_CATCH_UP_MESSAGES } from './historyWindow'
import type { Message } from './model'
import { RecoveryBatch } from './recoveryBatch'
import type { RecoveryRuntime } from './recoveryRuntime'
import { RecoveryState } from './recoveryState'

export type { RecoveryHistory, RecoveryRuntime } from './recoveryRuntime'

const browserStorage: Pick<Storage, 'getItem' | 'setItem'> = {
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
}

export class ChatRecovery {
  private readonly state: RecoveryState
  private readonly batch: RecoveryBatch
  private readonly historyRequests = new HistoryRequests()
  private runtime?: RecoveryRuntime
  private catchingUp = new Map<
    string,
    { promise: Promise<void>; socketGeneration: number; requiredSequence: string }
  >()
  private paging = new Set<string>()
  private navigationRevision = 0
  private retry: { chatId: string; attempt: number; timer?: ReturnType<typeof setTimeout> } | null =
    null
  private catchUpError: { chatId: string; message: string } | null = null
  private subscribedChatId: string | null = null
  private socketGeneration = 0
  private disposed = false
  private lifecycleGeneration = 0

  constructor(prefix: string, storage: Pick<Storage, 'getItem' | 'setItem'> = browserStorage) {
    this.batch = new RecoveryBatch(
      storage,
      () => this.runtime!,
      () => this.disposed,
    )
    this.state = new RecoveryState(prefix, storage, this.batch)
  }

  configure(runtime: RecoveryRuntime): void {
    this.runtime = runtime
  }

  private sendSubscription(chatId: string): boolean {
    const runtime = this.runtime!
    const context = runtime.context(chatId)
    if (!context.connected || context.removed || !context.kind) return false
    runtime.sendFrame(this.state.dismissalFrame(chatId))
    runtime.sendFrame({
      type: FrameType.SUBSCRIBE_MANY,
      version: 1,
      subscriptions: [
        { chatId, kind: context.kind, ...this.state.subscription(chatId, context.room) },
      ],
    })
    return true
  }

  onSelected(chatId: string | null): void {
    this.navigationRevision += 1
    this.paging.clear()
    this.disposed = false
    this.cancelRetryExcept(chatId)
    const runtime = this.runtime!
    this.state.compactWindows(chatId)
    runtime.changed()
    const connected = chatId
      ? runtime.context(chatId).connected
      : this.subscribedChatId
        ? runtime.context(this.subscribedChatId).connected
        : false
    if (!connected) return
    if (this.subscribedChatId && this.subscribedChatId !== chatId) {
      runtime.sendFrame({ type: FrameType.UNSUBSCRIBE, version: 1, chatId: this.subscribedChatId })
      this.subscribedChatId = null
    }
    if (
      chatId &&
      !chatId.startsWith('draft:') &&
      this.subscribedChatId !== chatId &&
      this.sendSubscription(chatId)
    ) {
      this.subscribedChatId = chatId
      void this.catchUp(chatId, !this.state.window(chatId).length)
    }
  }

  onSocketOpened(chatId: string | null): void {
    this.disposed = false
    this.socketGeneration += 1
    this.flush(false)
    this.subscribedChatId = null
    if (chatId && !chatId.startsWith('draft:') && this.sendSubscription(chatId)) {
      this.subscribedChatId = chatId
      void this.catchUp(chatId, !this.state.window(chatId).length)
    }
  }

  onSocketClosed(): void {
    this.socketGeneration += 1
    this.flush(false)
    this.subscribedChatId = null
    this.cancelRetry()
  }

  dispose(): void {
    this.disposed = true
    this.lifecycleGeneration += 1
    this.socketGeneration += 1
    this.cancelRetry()
    this.flush(false)
    this.catchingUp.clear()
    this.paging.clear()
    this.historyRequests.cancel()
  }

  onSubscriptionExpired(chatId: string): void {
    this.resubscribeSelected(chatId, true)
  }

  onChatCreated(chatId: string): void {
    this.resubscribeSelected(chatId)
  }

  private resubscribeSelected(chatId: string, expired = false): void {
    if (!this.runtime!.context(chatId).selected) return
    if (expired) this.subscribedChatId = null
    if (this.sendSubscription(chatId)) {
      this.subscribedChatId = chatId
      void this.catchUp(chatId)
    }
  }

  renewGroup(chatId: string): void {
    const context = this.runtime!.context(chatId)
    if (context.selected && context.kind === ChatKind.GROUP) this.sendSubscription(chatId)
  }

  private cancelRetry(): void {
    if (this.retry?.timer !== undefined) clearTimeout(this.retry.timer)
    this.retry = null
  }

  private cancelRetryExcept(chatId: string | null): void {
    if (this.retry && this.retry.chatId !== chatId) this.cancelRetry()
  }

  private async fetchLatest(
    chatId: string,
    moveViewport = false,
    initialize = false,
  ): Promise<{ latest?: string; messages: Message[] }> {
    const runtime = this.runtime!
    const generation = this.lifecycleGeneration
    const socketGeneration = this.socketGeneration
    const navigation = this.navigationRevision
    return (
      (await this.withHistorySnapshot(
        chatId,
        () => runtime.history.latest(chatId),
        (result) => {
          if (
            this.disposed ||
            generation !== this.lifecycleGeneration ||
            runtime.context(chatId).removed
          )
            return { latest: undefined, messages: [] }
          const page = this.state.latestPage(
            chatId,
            result.messages,
            moveViewport && navigation === this.navigationRevision,
            initialize,
            runtime.context(chatId).room,
            runtime.context(chatId).selected,
          )
          this.state.clearHistoryBuffer(chatId)
          runtime.changed()
          if (socketGeneration === this.socketGeneration) runtime.sendFrame(page.dismissal)
          if (moveViewport && navigation === this.navigationRevision) runtime.jumped()
          return { latest: page.latest, messages: page.messages }
        },
      )) ?? { latest: undefined, messages: [] }
    )
  }

  async showLatest(chatId: string): Promise<void> {
    const runtime = this.runtime!
    this.navigationRevision += 1
    this.paging.delete(chatId)
    if (this.state.returnToPinned(chatId)) {
      runtime.changed()
      runtime.jumped()
    }
    const beforeJump = this.baseline(chatId)
    const page = await this.fetchLatest(chatId, true)
    if (!page.latest || runtime.context(chatId).removed) return
    if (BigInt(page.latest) > BigInt(this.baseline(chatId))) {
      runtime.sendFrame(
        this.state.jumpToLatest(chatId, page.messages, runtime.context(chatId).room),
      )
    }
    runtime.sendFrame(this.state.appliedSince(chatId, beforeJump))
    runtime.changed()
  }

  async loadOlder(chatId: string): Promise<void> {
    const runtime = this.runtime!
    const generation = this.lifecycleGeneration
    const navigation = this.navigationRevision
    const first = this.state.window(chatId)[0]
    if (!first || first.sequence === '1' || this.paging.has(chatId)) return
    this.paging.add(chatId)
    try {
      await this.withHistorySnapshot(
        chatId,
        () => runtime.history.older(chatId, first.sequence),
        (page) => {
          if (
            this.disposed ||
            generation !== this.lifecycleGeneration ||
            navigation !== this.navigationRevision ||
            runtime.context(chatId).removed ||
            this.state.window(chatId)[0]?.sequence !== first.sequence
          )
            return
          this.state.page(chatId, page.messages, 'older')
          runtime.changed()
        },
      )
    } finally {
      if (generation === this.lifecycleGeneration && navigation === this.navigationRevision)
        this.paging.delete(chatId)
    }
  }

  async loadNewer(chatId: string): Promise<void> {
    const runtime = this.runtime!
    const generation = this.lifecycleGeneration
    const navigation = this.navigationRevision
    const last = this.state.window(chatId).at(-1)
    if (!last || this.paging.has(chatId)) return
    this.paging.add(chatId)
    try {
      await this.withHistorySnapshot(
        chatId,
        () => runtime.history.after(chatId, last.sequence),
        (page) => {
          if (
            this.disposed ||
            generation !== this.lifecycleGeneration ||
            navigation !== this.navigationRevision ||
            runtime.context(chatId).removed ||
            this.state.window(chatId).at(-1)?.sequence !== last.sequence
          )
            return
          this.state.page(chatId, page.messages, 'newer', page.hasMore)
          runtime.changed()
        },
      )
    } finally {
      if (generation === this.lifecycleGeneration && navigation === this.navigationRevision)
        this.paging.delete(chatId)
    }
  }

  catchUp(chatId: string, fromStart = false, requiredSequence = '0'): Promise<void> {
    if (this.disposed || chatId.startsWith('draft:')) return Promise.resolve()
    const current = this.catchingUp.get(chatId)
    if (current) {
      if (BigInt(requiredSequence) > BigInt(current.requiredSequence))
        current.requiredSequence = requiredSequence
      if (current.socketGeneration === this.socketGeneration) return current.promise
      const generation = this.lifecycleGeneration
      return current.promise.then(() => {
        if (!this.disposed && generation === this.lifecycleGeneration)
          return this.catchUp(chatId, fromStart, requiredSequence)
      })
    }
    const request = {
      promise: Promise.resolve(),
      socketGeneration: this.socketGeneration,
      requiredSequence,
    }
    this.catchingUp.set(chatId, request)
    request.promise = this.performCatchUp(
      chatId,
      fromStart,
      () => request.requiredSequence,
    ).finally(() => {
      if (this.catchingUp.get(chatId) === request) this.catchingUp.delete(chatId)
    })
    return request.promise
  }

  private async performCatchUp(
    chatId: string,
    fromStart: boolean,
    requiredSequence: () => string,
  ): Promise<void> {
    const runtime = this.runtime!
    const generation = this.lifecycleGeneration
    const socketGeneration = this.socketGeneration
    if (this.disposed) return
    const beforeCatchUp = this.baseline(chatId)
    let observedLatest = '0'
    const loadLatest = async (moveViewport = false, initialize = false) => {
      const snapshot = await this.fetchLatest(chatId, moveViewport, initialize)
      observedLatest = snapshot.latest ?? '0'
    }
    try {
      const context = runtime.context(chatId)
      if (fromStart || !this.state.hasBaseline(chatId)) {
        await loadLatest(fromStart, !this.state.hasBaseline(chatId))
      } else if (context.selected && (this.state.isDetached(chatId) || context.readingHistory)) {
        await loadLatest()
      } else if (this.state.shouldFetchLatest(chatId)) {
        this.state.deferGap(chatId)
        await loadLatest()
      } else {
        let after = this.baseline(chatId)
        for (let page = 0; page < MAX_CATCH_UP_MESSAGES / HISTORY_PAGE_SIZE; page += 1) {
          if (BigInt(this.baseline(chatId)) > BigInt(after)) break
          const result = await this.withHistorySnapshot(
            chatId,
            () => runtime.history.after(chatId, after),
            (page) => {
              if (
                this.disposed ||
                generation !== this.lifecycleGeneration ||
                runtime.context(chatId).removed ||
                BigInt(this.baseline(chatId)) > BigInt(after)
              )
                return undefined
              this.state.incorporateHistory(chatId, page.messages, runtime.context(chatId).selected)
              if (page.messages.length) runtime.changed()
              return page
            },
          )
          if (!result) break
          if (!result.hasMore || result.messages.length === 0) break
          if (BigInt(result.nextSequence) <= BigInt(after))
            throw new Error('History cursor did not advance')
          after = result.nextSequence
          if (page === MAX_CATCH_UP_MESSAGES / HISTORY_PAGE_SIZE - 1) {
            this.state.deferGap(chatId)
            await loadLatest()
          }
        }
        if (this.state.hasHistoryGap(chatId)) throw new Error('History contains a sequence gap')
      }
      if (
        this.disposed ||
        generation !== this.lifecycleGeneration ||
        runtime.context(chatId).removed
      )
        return
      if (
        BigInt(this.baseline(chatId)) < BigInt(requiredSequence()) &&
        BigInt(observedLatest) < BigInt(requiredSequence())
      ) {
        if (
          this.state.shouldFetchLatest(chatId) ||
          runtime.context(chatId).readingHistory ||
          this.state.isDetached(chatId)
        )
          await loadLatest()
      }
      if (
        this.disposed ||
        generation !== this.lifecycleGeneration ||
        runtime.context(chatId).removed
      )
        return
      if (
        BigInt(this.baseline(chatId)) < BigInt(requiredSequence()) &&
        BigInt(observedLatest) < BigInt(requiredSequence())
      )
        throw new Error('Saved messages are not visible in history yet')
      if (socketGeneration === this.socketGeneration && !runtime.context(chatId).removed)
        runtime.sendFrame(this.state.appliedSince(chatId, beforeCatchUp))
      if (this.retry?.chatId === chatId) this.cancelRetry()
      if (this.catchUpError?.chatId === chatId) {
        runtime.recovered(this.catchUpError.message)
        this.catchUpError = null
      }
    } catch (cause) {
      if (this.disposed || generation !== this.lifecycleGeneration) return
      const message = cause instanceof Error ? cause.message : 'Could not load chat history'
      this.catchUpError = { chatId, message }
      runtime.failed(message)
      const context = runtime.context(chatId)
      if (
        context.selected &&
        context.connected &&
        !context.removed &&
        this.retry?.timer === undefined
      ) {
        const attempt = this.retry?.chatId === chatId ? this.retry.attempt + 1 : 1
        const timer = setTimeout(() => {
          if (this.retry?.chatId !== chatId) return
          this.retry.timer = undefined
          const current = this.runtime?.context(chatId)
          if (current?.selected && current.connected && !current.removed)
            void this.catchUp(chatId, false, requiredSequence())
        }, reconnectDelay(attempt))
        this.retry = { chatId, attempt, timer }
      }
    }
  }

  private handleLive(
    message: Message,
    room: string,
    canAcknowledge: () => boolean,
    epoch?: string,
    streamId?: string,
  ): RecoveryFrame | null | Promise<RecoveryFrame | null> {
    const runtime = this.runtime!
    const chatId = message.chatId
    const protectedMessage = this.historyRequests.protectLive(message)
    if (!protectedMessage) return null
    const decision = this.state.liveMessage(chatId, message.sequence)
    if (
      decision.incorporate &&
      !runtime.context(chatId).removed &&
      (BigInt(message.sequence) > BigInt(this.baseline(chatId)) ||
        this.state.retains(chatId, message.id))
    ) {
      const context = runtime.context(chatId)
      this.state.receive(chatId, [protectedMessage], context.selected, context.readingHistory)
      this.batch.notify()
    }
    const acknowledge = () => {
      if (!decision.incorporate) return null
      if (runtime.context(chatId).removed || !canAcknowledge()) return null
      return this.state.acknowledgeLive(chatId, message.sequence, room, epoch, streamId)
    }
    return decision.catchUp ? this.catchUp(chatId).then(acknowledge) : acknowledge()
  }

  async onLive(
    message: Message,
    room: string,
    canAcknowledge: () => boolean,
    epoch?: string,
    streamId?: string,
  ): Promise<void> {
    if (this.disposed) return
    const generation = this.socketGeneration
    const ownsSocket = () =>
      !this.disposed && generation === this.socketGeneration && canAcknowledge()
    if (
      message.replyToMessageId &&
      !this.state.retains(message.chatId, message.replyToMessageId) &&
      BigInt(message.sequence) > BigInt(this.baseline(message.chatId))
    ) {
      if (!ownsSocket()) return
      this.runtime!.sendFrame({
        type: FrameType.RECEIVED_MESSAGE,
        version: 1,
        chatId: message.chatId,
        sequence: message.sequence,
      })
      if (this.state.recordLatest(message.chatId, message.sequence)) this.batch.notify()
      await this.catchUp(message.chatId, false, message.sequence)
      if (!ownsSocket()) return
      if (
        BigInt(message.sequence) > BigInt(this.baseline(message.chatId)) &&
        !this.state.retains(message.chatId, message.id)
      ) {
        return
      }
    }
    const acknowledgement = this.handleLive(message, room, ownsSocket, epoch, streamId)
    if (!(acknowledgement instanceof Promise) && acknowledgement && ownsSocket()) {
      this.batch.acknowledge(acknowledgement, ownsSocket)
      return
    }
    if (ownsSocket())
      this.runtime!.sendFrame({
        type: FrameType.RECEIVED_MESSAGE,
        version: 1,
        chatId: message.chatId,
        sequence: message.sequence,
      })
    const applied = await acknowledgement
    if (applied && ownsSocket()) this.batch.acknowledge(applied, ownsSocket)
  }

  beginNavigation(): number {
    this.paging.clear()
    return ++this.navigationRevision
  }
  reveal(chatId: string, messages: Message[], revision: number): boolean {
    if (
      this.disposed ||
      revision !== this.navigationRevision ||
      !this.runtime!.context(chatId).selected ||
      this.runtime!.context(chatId).removed
    )
      return false
    this.state.installAround(chatId, messages)
    this.runtime!.changed()
    return true
  }
  withHistorySnapshot<T extends { messages: Message[] }, R>(
    chatId: string,
    fetch: () => Promise<T>,
    install: (page: T) => R,
  ): Promise<R | undefined> {
    return this.historyRequests.run(chatId, fetch, install)
  }
  patch(chatId: string, messages: Message[]): void {
    const context = this.runtime!.context(chatId)
    if (context.removed) return
    const forward = messages.filter(
      (message) => BigInt(message.sequence) > BigInt(this.baseline(chatId)),
    )
    if (forward.length) {
      this.state.receive(chatId, forward, context.selected, context.readingHistory)
      if (forward.some((message) => BigInt(message.sequence) > BigInt(this.baseline(chatId))))
        void this.catchUp(chatId)
    }
    this.historyRequests.patch(chatId, messages)
    this.state.patch(chatId, messages)
    this.runtime!.changed()
  }
  latestWindows(): Record<string, Message[]> {
    return this.state.latestWindows()
  }
  isDetached(chatId: string): boolean {
    return this.state.isDetached(chatId)
  }

  flush(sendAcknowledgements = true): void {
    this.batch.flush(sendAcknowledgements)
  }
  baseline(chatId: string): string {
    return this.state.baseline(chatId)
  }
  visibleWindows(): Record<string, Message[]> {
    return this.state.visibleWindows()
  }
  latestSequences(): Record<string, string> {
    return this.state.latestSequences()
  }
  recordLatest(chatId: string, sequence: string): boolean {
    return this.state.recordLatest(chatId, sequence)
  }

  forget(chatId: string): void {
    this.navigationRevision += 1
    this.paging.delete(chatId)
    if (this.subscribedChatId === chatId) this.subscribedChatId = null
    if (this.retry?.chatId === chatId) this.cancelRetry()
    if (this.catchUpError?.chatId === chatId) this.catchUpError = null
    this.historyRequests.cancel(chatId)
    this.state.forget(chatId)
  }
}
