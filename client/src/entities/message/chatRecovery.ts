import { ChatKind, FrameType } from '../../shared/api/generated/socket-vocabulary'
import { isWaitingFailure } from '../../shared/api/http'
import type { RecoveryFrame } from '../../shared/api/socket'
import { reconnectDelay } from '../../shared/lib/reconnect'
import { restoreAnchor } from './anchorRestoration'
import { HistoryRequests } from './historyRequests'
import {
  type ChangesSnapshot,
  type HistorySnapshot,
  type MessageChange,
  type SnapshotMetadata,
} from './historySnapshot'
import { HISTORY_PAGE_SIZE, MAX_CATCH_UP_MESSAGES } from './historyWindow'
import type { Message } from './model'
import { pagingFailure, resetPagingFailures } from './pagingFailures'
import { ReadingLocations, type ReadingLocation } from './readingLocation'
import { RecoveryBatch } from './recoveryBatch'
import type { RecoveryRuntime } from './recoveryRuntime'
import { RecoveryState } from './recoveryState'

export type { RecoveryHistory, RecoveryRuntime } from './recoveryRuntime'

const browserStorage: Pick<Storage, 'getItem' | 'setItem'> = {
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
}

type CatchUpRetry = { chatId: string; attempt: number } & (
  { phase: 'scheduled'; timer: ReturnType<typeof setTimeout> } | { phase: 'retrying' }
)

export class ChatRecovery {
  private readonly state: RecoveryState
  private readonly batch: RecoveryBatch
  private readonly historyRequests = new HistoryRequests()
  private readonly locations: ReadingLocations
  private synchronizing = new Map<
    string,
    { promise: Promise<void>; phase: 'refreshing' | 'invalidated' }
  >()
  private synchronizationQueue = new Map<string, { promise: Promise<void>; resolve(): void }>()
  private runtime?: RecoveryRuntime
  private catchingUp = new Map<
    string,
    { promise: Promise<void>; socketGeneration: number; requiredSequence: string }
  >()
  private paging = new Set<string>()
  private pageFailures = new Map<string, { context: string; attempts: number; until: number }>()

  private pageContext(chatId: string, cursor: string): string {
    return JSON.stringify([
      cursor,
      this.navigationRevision,
      this.socketGeneration,
      this.state.snapshotMetadata(chatId),
    ])
  }

  private pageAllowed(key: string, context: string): boolean {
    const failure = this.pageFailures.get(key)
    return !failure || failure.context !== context || Date.now() >= failure.until
  }

  private pageFailed(key: string, context: string, cause: unknown): void {
    const previous = this.pageFailures.get(key)
    const attempts = previous?.context === context ? previous.attempts + 1 : 1
    const separator = key.indexOf(':')
    const direction = key.slice(0, separator) as 'older' | 'newer'
    const until = pagingFailure(key.slice(separator + 1), direction, cause, attempts)
    this.pageFailures.set(key, { context, attempts, until })
  }
  private navigationRevision = 0
  private restoring = new Map<string, number>()
  private restoreWaits = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; release(): void }
  >()
  private retry: CatchUpRetry | null = null
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
    this.locations = new ReadingLocations(`${prefix}.reading-locations.v1`, storage)
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
    this.cancelRestoreWaits()
    this.navigationRevision += 1
    this.paging.clear()
    for (const key of this.pageFailures.keys()) resetPagingFailures(key.slice(key.indexOf(':') + 1))
    this.pageFailures.clear()
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
    if (!connected) {
      if (chatId && !chatId.startsWith('draft:')) void this.open(chatId)
      return
    }
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
      void this.open(chatId)
    }
  }

  onSocketOpened(chatId: string | null): void {
    this.disposed = false
    this.socketGeneration += 1
    for (const key of this.pageFailures.keys()) resetPagingFailures(key.slice(key.indexOf(':') + 1))
    this.flush(false)
    this.subscribedChatId = null
    if (chatId && !chatId.startsWith('draft:') && this.sendSubscription(chatId)) {
      this.subscribedChatId = chatId
      if (this.locations.get(chatId)?.atLatest === false) void this.open(chatId)
      else void this.catchUp(chatId, !this.state.window(chatId).length)
    }
  }

  onSocketClosed(): void {
    this.socketGeneration += 1
    this.flush(false)
    this.subscribedChatId = null
    this.cancelRetry()
  }

  dispose(): void {
    this.cancelRestoreWaits()
    this.disposed = true
    this.lifecycleGeneration += 1
    this.socketGeneration += 1
    this.cancelRetry()
    this.flush(false)
    this.catchingUp.clear()
    this.paging.clear()
    for (const key of this.pageFailures.keys()) resetPagingFailures(key.slice(key.indexOf(':') + 1))
    this.pageFailures.clear()
    this.historyRequests.cancel()
    this.synchronizing.clear()
    for (const queued of this.synchronizationQueue.values()) queued.resolve()
    this.synchronizationQueue.clear()
    this.restoring.clear()
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
    if (this.retry?.phase === 'scheduled') clearTimeout(this.retry.timer)
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
            result,
          )
          this.state.clearHistoryBuffer(chatId)
          runtime.changed()
          if (socketGeneration === this.socketGeneration) runtime.sendFrame(page.dismissal)
          if (moveViewport && navigation === this.navigationRevision) runtime.jumped()
          return { latest: result.snapshotSequence ?? page.latest, messages: page.messages }
        },
      )) ?? { latest: undefined, messages: [] }
    )
  }

  async showLatest(chatId: string): Promise<void> {
    this.cancelRestoreWaits()
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
    const last = this.state.window(chatId).at(-1)
    if (last)
      this.locations.remember(chatId, {
        messageId: last.id,
        sequence: last.sequence,
        offsetPx: 0,
        atLatest: true,
      })
    runtime.locationRestored?.(chatId, this.locations.get(chatId))
  }

  readingLocation(chatId: string): ReadingLocation | undefined {
    return this.locations.get(chatId)
  }

  rememberLocation(chatId: string, location: ReadingLocation): void {
    this.locations.remember(chatId, location)
  }

  private async open(chatId: string): Promise<void> {
    const location = this.locations.get(chatId)
    if (!location || location.atLatest || !this.runtime!.history.around) {
      await this.catchUp(chatId, true)
      this.runtime!.locationRestored?.(chatId, this.locations.get(chatId))
      return
    }
    const revision = this.navigationRevision
    if (this.restoring.get(chatId) === revision) return
    this.restoring.set(chatId, revision)
    const generation = this.lifecycleGeneration
    const current = () =>
      !this.disposed &&
      generation === this.lifecycleGeneration &&
      revision === this.navigationRevision &&
      this.runtime!.context(chatId).selected &&
      !this.runtime!.context(chatId).removed
    const pause = () =>
      new Promise<void>((release) => {
        const wait = {
          timer: setTimeout(() => {
            if (this.restoreWaits.get(chatId) === wait) this.restoreWaits.delete(chatId)
            release()
          }, 50),
          release,
        }
        this.restoreWaits.set(chatId, wait)
      })
    try {
      while (current()) {
        const installed = await this.withHistorySnapshot(
          chatId,
          async () => {
            let initial
            while (current() && !initial) {
              initial = await this.withHistorySnapshot(
                chatId,
                () => this.runtime!.history.around!(chatId, location.messageId, location.sequence),
                (page) => page,
              )
              if (!initial && current()) await pause()
            }
            if (!initial || !current())
              throw new Error('Reading position restoration was cancelled')
            this.runtime!.changed()
            const page = await restoreAnchor({
              initial,
              sequence: location.sequence,
              current,
              pause,
              newer: (cursor) =>
                this.withHistorySnapshot(
                  chatId,
                  () => this.runtime!.history.after(chatId, cursor),
                  (result) => result,
                ),
              older: (cursor) =>
                this.withHistorySnapshot(
                  chatId,
                  () => this.runtime!.history.older(chatId, cursor),
                  (result) => result,
                ),
            })
            if (!page || !current()) throw new Error('Reading position restoration was cancelled')
            return page
          },
          (page) => {
            if (!current()) return false
            this.state.installAround(chatId, page.messages, page)
            const anchor = page.messages.find((message) => message.id === page.anchorMessageId)
            const restored = anchor
              ? { ...location, messageId: anchor.id, sequence: anchor.sequence }
              : undefined
            if (restored) this.locations.remember(chatId, restored)
            else this.locations.forget(chatId)
            this.runtime!.changed()
            this.runtime!.locationRestored?.(chatId, restored)
            return true
          },
        )
        if (installed) {
          await this.catchUp(chatId)
          return
        }
        if (current()) await pause()
      }
    } catch (cause) {
      if (
        !this.disposed &&
        generation === this.lifecycleGeneration &&
        revision === this.navigationRevision &&
        !isWaitingFailure(cause)
      )
        this.runtime!.failed(
          cause instanceof Error ? cause.message : 'Could not restore reading position',
        )
    } finally {
      if (this.restoring.get(chatId) === revision) this.restoring.delete(chatId)
    }
  }

  private cancelRestoreWaits(): void {
    for (const wait of this.restoreWaits.values()) {
      clearTimeout(wait.timer)
      wait.release()
    }
    this.restoreWaits.clear()
  }

  async loadOlder(chatId: string): Promise<void> {
    const runtime = this.runtime!
    const generation = this.lifecycleGeneration
    const navigation = this.navigationRevision
    const first = this.state.window(chatId)[0]
    const cursor = this.state.pageCursor(chatId, 'older') ?? first?.sequence
    if (
      !cursor ||
      cursor === '0' ||
      (cursor === '1' && this.state.availability(chatId).hasOlderMessages === undefined) ||
      this.paging.has(chatId)
    )
      return
    const key = `older:${chatId}`
    const context = this.pageContext(chatId, cursor)
    if (!this.pageAllowed(key, context)) return
    this.paging.add(chatId)
    try {
      await this.withHistorySnapshot(
        chatId,
        () => runtime.history.older(chatId, cursor),
        (page) => {
          if (
            this.disposed ||
            generation !== this.lifecycleGeneration ||
            navigation !== this.navigationRevision ||
            runtime.context(chatId).removed ||
            (this.state.pageCursor(chatId, 'older') ?? this.state.window(chatId)[0]?.sequence) !==
              cursor
          )
            return
          this.state.page(chatId, page.messages, 'older', page.hasMore, page)
          runtime.changed()
        },
      )
      this.pageFailures.delete(key)
    } catch (cause) {
      if (generation === this.lifecycleGeneration && navigation === this.navigationRevision)
        this.pageFailed(key, context, cause)
      throw cause
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
    const cursor = this.state.pageCursor(chatId, 'newer') ?? last?.sequence
    if (!cursor || this.paging.has(chatId)) return
    const key = `newer:${chatId}`
    const context = this.pageContext(chatId, cursor)
    if (!this.pageAllowed(key, context)) return
    this.paging.add(chatId)
    try {
      await this.withHistorySnapshot(
        chatId,
        () => runtime.history.after(chatId, cursor),
        (page) => {
          if (
            this.disposed ||
            generation !== this.lifecycleGeneration ||
            navigation !== this.navigationRevision ||
            runtime.context(chatId).removed ||
            (this.state.pageCursor(chatId, 'newer') ??
              this.state.window(chatId).at(-1)?.sequence) !== cursor
          )
            return
          this.state.page(chatId, page.messages, 'newer', page.hasMore, page)
          runtime.changed()
        },
      )
      this.pageFailures.delete(key)
    } catch (cause) {
      if (generation === this.lifecycleGeneration && navigation === this.navigationRevision)
        this.pageFailed(key, context, cause)
      throw cause
    } finally {
      if (generation === this.lifecycleGeneration && navigation === this.navigationRevision)
        this.paging.delete(chatId)
    }
  }

  catchUp(
    chatId: string,
    fromStart = false,
    requiredSequence = '0',
    allowLiveArrival = false,
  ): Promise<void> {
    if (this.disposed || chatId.startsWith('draft:')) return Promise.resolve()
    const current = this.catchingUp.get(chatId)
    if (current) {
      if (BigInt(requiredSequence) > BigInt(current.requiredSequence))
        current.requiredSequence = requiredSequence
      if (current.socketGeneration === this.socketGeneration) return current.promise
      const generation = this.lifecycleGeneration
      return current.promise.then(() => {
        if (!this.disposed && generation === this.lifecycleGeneration)
          return this.catchUp(chatId, fromStart, requiredSequence, allowLiveArrival)
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
      allowLiveArrival,
    ).finally(() => {
      if (this.catchingUp.get(chatId) === request) this.catchingUp.delete(chatId)
    })
    return request.promise
  }

  private async performCatchUp(
    chatId: string,
    fromStart: boolean,
    requiredSequence: () => string,
    allowLiveArrival: boolean,
  ): Promise<void> {
    const runtime = this.runtime!
    const generation = this.lifecycleGeneration
    const socketGeneration = this.socketGeneration
    if (this.disposed) return
    const capacity = this.historyRequests.waitForCapacity()
    if (capacity) {
      await capacity
      if (this.disposed || generation !== this.lifecycleGeneration) return
    }
    const context = runtime.context(chatId)
    if (
      allowLiveArrival &&
      this.state.window(chatId).length &&
      BigInt(this.state.window(chatId)[0].sequence) <= BigInt(this.baseline(chatId)) &&
      !fromStart &&
      requiredSequence() !== '0' &&
      context.selected &&
      context.connected &&
      !context.readingHistory &&
      !this.state.isDetached(chatId)
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1250))
      if (this.disposed || generation !== this.lifecycleGeneration) return
      if (BigInt(this.baseline(chatId)) >= BigInt(requiredSequence())) return
    }
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
              this.state.incorporateHistory(
                chatId,
                page.messages,
                runtime.context(chatId).selected,
                page,
              )
              runtime.changed()
              return page
            },
          )
          if (!result) break
          if (!result.hasMore) break
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
      if (!isWaitingFailure(cause)) runtime.failed(message)
      const context = runtime.context(chatId)
      if (
        context.selected &&
        context.connected &&
        !context.removed &&
        this.retry?.phase !== 'scheduled'
      ) {
        const attempt = this.retry?.chatId === chatId ? this.retry.attempt + 1 : 1
        const timer = setTimeout(() => {
          if (this.retry?.chatId !== chatId) return
          this.retry = { phase: 'retrying', chatId, attempt }
          const current = this.runtime?.context(chatId)
          if (current?.selected && current.connected && !current.removed)
            void this.catchUp(chatId, false, requiredSequence())
        }, reconnectDelay(attempt))
        this.retry = { phase: 'scheduled', chatId, attempt, timer }
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
    if (!this.state.eligible(message))
      return this.state.acknowledgeLive(chatId, message.sequence, room, epoch, streamId)
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
    return decision.catchUp
      ? this.catchUp(chatId, false, message.sequence, true).then(acknowledge)
      : acknowledge()
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
    let resolvedReply = false
    const hydrated = this.state.hydrateReply(message)
    if (hydrated) message = hydrated
    if (
      this.runtime!.history.resolve &&
      (this.state.requiresResolution(message) ||
        (message.replyToMessageId &&
          (!hydrated || !this.state.retains(message.chatId, message.replyToMessageId))))
    ) {
      if (!ownsSocket()) return
      this.runtime!.sendFrame({
        type: FrameType.RECEIVED_MESSAGE,
        version: 1,
        chatId: message.chatId,
        sequence: message.sequence,
      })
      const ids = message.replyToMessageId ? [message.id, message.replyToMessageId] : [message.id]
      const resolved = await this.withHistorySnapshot(
        message.chatId,
        () => this.runtime!.history.resolve!(message.chatId, ids),
        (page) => {
          this.state.resolve(message.chatId, ids, page)
          return page.messages.find((row) => row.id === message.id)
        },
      ).catch(() => undefined)
      if (!resolved || !ownsSocket()) {
        if (ownsSocket()) await this.catchUp(message.chatId, false, message.sequence)
        return
      }
      message = resolved
      resolvedReply = true
    }
    if (
      message.replyToMessageId &&
      !resolvedReply &&
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
    this.cancelRestoreWaits()
    this.paging.clear()
    for (const key of this.pageFailures.keys()) resetPagingFailures(key.slice(key.indexOf(':') + 1))
    this.pageFailures.clear()
    return ++this.navigationRevision
  }
  reveal(
    chatId: string,
    messages: Message[],
    revision: number,
    page?: HistorySnapshot & { hasOlder?: boolean; hasNewer?: boolean },
  ): boolean {
    if (
      this.disposed ||
      revision !== this.navigationRevision ||
      !this.runtime!.context(chatId).selected ||
      this.runtime!.context(chatId).removed
    )
      return false
    this.state.installAround(chatId, messages, page)
    this.runtime!.changed()
    return true
  }
  withHistorySnapshot<T extends { messages: Message[] } & Partial<SnapshotMetadata>, R>(
    chatId: string,
    fetch: () => Promise<T>,
    install: (page: T) => R,
  ): Promise<R | undefined> {
    this.historyRequests.observe(chatId, this.state.snapshotMetadata(chatId))
    return this.historyRequests.run(chatId, fetch, (page) => {
      this.state.reconcileSnapshot(chatId, page)
      if (page.visibilityRevision !== undefined)
        this.state.resolve(
          chatId,
          page.messages.map((message) => message.id),
          page,
        )
      if (
        !this.state.verifiedSnapshot(chatId) &&
        page.mutationRevision !== undefined &&
        page.visibilityRevision !== undefined
      )
        this.state.verifySnapshot(chatId, {
          mutationRevision: page.mutationRevision,
          visibilityRevision: page.visibilityRevision,
        })
      return install(page)
    })
  }

  fetchChanges<T extends ChangesSnapshot>(
    chatId: string,
    fetch: () => Promise<T>,
  ): Promise<T | undefined> {
    this.historyRequests.observe(chatId, this.state.snapshotMetadata(chatId))
    return this.historyRequests.run(
      chatId,
      async () => {
        const page = await fetch()
        return {
          ...page,
          mutationRevision: page.lastRevision,
          messages: page.changes.flatMap((change) => (change.message ? [change.message] : [])),
        }
      },
      (page) => {
        const byId = new Map(page.messages.map((message) => [message.id, message]))
        return {
          ...page,
          changes: page.changes.map((change) =>
            change.message ? { ...change, message: byId.get(change.message.id)! } : change,
          ),
        }
      },
    )
  }

  observe(chatId: string, snapshot: Partial<SnapshotMetadata>): void {
    const previous = this.state.snapshotMetadata(chatId)
    if (
      (snapshot.mutationRevision !== undefined &&
        snapshot.mutationRevision !== previous.mutationRevision) ||
      (snapshot.visibilityRevision !== undefined &&
        snapshot.visibilityRevision !== previous.visibilityRevision)
    )
      resetPagingFailures(chatId)
    this.historyRequests.observe(chatId, snapshot)
    this.state.observeSnapshot(chatId, snapshot)
    const location = this.locations.get(chatId)
    if (
      location &&
      (BigInt(location.sequence) <= BigInt(snapshot.clearedThroughSequence ?? '0') ||
        BigInt(location.sequence) <= BigInt(snapshot.globalClearedThroughSequence ?? '0'))
    ) {
      this.locations.forget(chatId)
      this.state.settleLatest(chatId)
      this.runtime!.locationRestored?.(chatId, undefined)
      if (this.runtime!.context(chatId).selected) this.runtime!.jumped()
    }
    this.runtime!.changed()
  }

  synchronize(chatId: string, snapshot: Partial<SnapshotMetadata> = {}): Promise<void> {
    this.observe(chatId, snapshot)
    if (!this.runtime!.history.visibility || !this.runtime!.history.resolve || this.disposed)
      return Promise.resolve()
    const running = this.synchronizing.get(chatId)
    if (running) {
      running.phase = 'invalidated'
      return running.promise
    }
    const queued = this.synchronizationQueue.get(chatId)
    if (queued) return queued.promise
    if (this.synchronizing.size >= 4) {
      let resolve!: () => void
      const promise = new Promise<void>((done) => {
        resolve = done
      })
      if (this.synchronizationQueue.size >= 100) {
        const first = this.synchronizationQueue.keys().next().value!
        this.synchronizationQueue.get(first)!.resolve()
        this.synchronizationQueue.delete(first)
      }
      this.synchronizationQueue.set(chatId, { promise, resolve })
      return promise
    }
    const request: {
      promise: Promise<void>
      phase: 'refreshing' | 'invalidated'
    } = { promise: Promise.resolve(), phase: 'refreshing' }
    const invalidated = () => request.phase === 'invalidated'
    const generation = this.lifecycleGeneration
    const valid = () =>
      !this.disposed &&
      generation === this.lifecycleGeneration &&
      !this.runtime!.context(chatId).removed
    request.promise = (async () => {
      do {
        request.phase = 'refreshing'
        const visibility = await this.runtime!.history.visibility!(chatId)
        if (!valid() || !this.historyRequests.accepts(chatId, visibility)) return
        const previous = this.state.verifiedSnapshot(chatId)
        const changed =
          BigInt(visibility.mutationRevision) > BigInt(previous?.mutationRevision ?? '0') ||
          BigInt(visibility.visibilityRevision) > BigInt(previous?.visibilityRevision ?? '0')
        const { snapshotSequence, ...metadata } = visibility
        this.observe(chatId, metadata)
        this.recordLatest(chatId, snapshotSequence)
        if (visibility.hidden) {
          this.runtime!.hidden?.(chatId)
          return
        }
        if (!changed) {
          if (BigInt(visibility.snapshotSequence) > BigInt(this.baseline(chatId)))
            await this.catchUp(chatId, false, visibility.snapshotSequence, true)
          continue
        }
        const ids = this.state.retainedIds(chatId)
        for (let index = 0; index < ids.length; index += 100) {
          const batch = ids.slice(index, index + 100)
          await this.withHistorySnapshot(
            chatId,
            () => this.runtime!.history.resolve!(chatId, batch),
            (page) => {
              if (valid()) this.state.resolve(chatId, batch, page)
            },
          )
        }
        if (!valid()) return
        await this.fetchLatest(
          chatId,
          !this.state.isDetached(chatId) && !this.runtime!.context(chatId).readingHistory,
        )
        this.state.verifySnapshot(chatId, {
          mutationRevision: visibility.mutationRevision,
          visibilityRevision: visibility.visibilityRevision,
        })
        this.runtime!.changed()
      } while (invalidated() && valid())
    })()
      .catch((cause) => {
        if (valid() && !isWaitingFailure(cause))
          this.runtime!.failed(
            cause instanceof Error ? cause.message : 'Could not refresh conversation',
          )
      })
      .finally(() => {
        if (this.synchronizing.get(chatId) === request) this.synchronizing.delete(chatId)
        const next = this.synchronizationQueue.entries().next().value
        if (next && !this.disposed) {
          this.synchronizationQueue.delete(next[0])
          void this.synchronize(next[0]).finally(next[1].resolve)
        }
      })
    this.synchronizing.set(chatId, request)
    return request.promise
  }

  availability(chatId: string): { hasOlderMessages?: boolean; hasNewerMessages?: boolean } {
    return this.state.availability(chatId, this.runtime?.context(chatId).readingHistory ?? true)
  }

  mutationRevision(chatId: string): string {
    return this.state.mutationRevision(chatId)
  }

  acceptsSaved(chatId: string, messageId: string, sequence: string): boolean {
    const snapshotSequence = this.state.snapshotMetadata(chatId).snapshotSequence
    return (
      this.state.eligible({ chatId, sequence }) &&
      (this.state.retains(chatId, messageId) ||
        (snapshotSequence !== undefined &&
          BigInt(sequence) > BigInt(this.baseline(chatId)) &&
          BigInt(sequence) > BigInt(snapshotSequence)))
    )
  }

  revisionKey(chatId: string): string {
    return this.state.revisionKey(chatId)
  }

  async resolveTarget(chatId: string, messageId: string): Promise<Message | undefined> {
    if (!this.runtime!.history.resolve)
      return this.state.window(chatId).find((message) => message.id === messageId)
    const result = await this.withHistorySnapshot(
      chatId,
      () => this.runtime!.history.resolve!(chatId, [messageId]),
      (page) => {
        this.state.resolve(chatId, [messageId], page)
        this.runtime!.changed()
        return page
      },
    )
    if (!result) throw new Error('Conversation changed while loading the message')
    return result.messages.find((message) => message.id === messageId)
  }

  applyChanges(
    chatId: string,
    changes: MessageChange[],
    snapshot: Partial<SnapshotMetadata> = {},
  ): boolean {
    this.historyRequests.observe(chatId, this.state.snapshotMetadata(chatId))
    if (!this.historyRequests.accepts(chatId, snapshot)) return false
    const previous = this.state.snapshotMetadata(chatId)
    const changed =
      BigInt(snapshot.mutationRevision ?? '0') > BigInt(previous.mutationRevision ?? '0') ||
      BigInt(snapshot.visibilityRevision ?? '0') > BigInt(previous.visibilityRevision ?? '0')
    const { snapshotSequence, ...metadata } = snapshot
    this.observe(chatId, changes.length || changed ? snapshot : metadata)
    if (snapshotSequence) this.recordLatest(chatId, snapshotSequence)
    const ids = changes.flatMap((change) =>
      change.messageId ? [change.messageId] : change.message ? [change.message.id] : [],
    )
    const messages = changes.flatMap((change) => (change.message ? [change.message] : []))
    if (ids.length) this.state.resolve(chatId, ids, { ...snapshot, messages })
    if (messages.length) this.patchAccepted(chatId, messages)
    this.runtime!.changed()
    return true
  }
  patch(chatId: string, messages: Message[]): void {
    if (!this.runtime!.history.resolve) {
      this.patchAccepted(chatId, messages)
      return
    }
    const needsResolution = (message: Message) =>
      Boolean(message.replyToMessageId) || this.state.requiresResolution(message)
    const unverified = messages.filter(needsResolution)
    const accepted = messages.filter((message) => !needsResolution(message))
    if (accepted.length) this.patchAccepted(chatId, accepted)
    const verify = async () => {
      for (let index = 0; index < unverified.length; index += 100) {
        const ids = unverified.slice(index, index + 100).map((message) => message.id)
        await this.withHistorySnapshot(
          chatId,
          () => this.runtime!.history.resolve!(chatId, ids),
          (page) => {
            this.state.resolve(chatId, ids, page)
            if (page.messages.length) this.patchAccepted(chatId, page.messages)
            this.runtime!.changed()
          },
        )
      }
    }
    if (unverified.length) void verify().catch(() => {})
  }

  private patchAccepted(chatId: string, messages: Message[]): void {
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
    this.locations.forget(chatId)
    this.synchronizationQueue.get(chatId)?.resolve()
    this.synchronizationQueue.delete(chatId)
  }
}
