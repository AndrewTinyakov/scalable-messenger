import { isWaitingFailure } from '../../shared/api/http'

type PagingFailure = { chatId: string; direction?: 'older' | 'newer'; until: number }
const listeners = new Set<(failure: PagingFailure) => void>()

export function pagingFailure(
  chatId: string,
  direction: 'older' | 'newer',
  cause: unknown,
  attempts: number,
): number {
  const transient = isWaitingFailure(cause)
  const until = transient
    ? Date.now() + Math.min(30000, 1000 * 2 ** Math.min(attempts - 1, 5))
    : Infinity
  for (const listener of listeners) listener({ chatId, direction, until })
  return until
}

export function resetPagingFailures(chatId: string): void {
  for (const listener of listeners) listener({ chatId, until: 0 })
}

export function subscribePagingFailures(listener: (failure: PagingFailure) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
