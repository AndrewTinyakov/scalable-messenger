import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { SendRequests } from '../entities/message/sendRequests'
import { useMessengerSends } from './useMessengerSends'

it('recovers independent saved chats with four workers and deduplicates chats', async () => {
  const dom = new JSDOM('<div id="root"></div>')
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const root = createRoot(document.getElementById('root')!)
  const releases = new Map<string, () => void>()
  const catchUp = vi.fn((id: string) => new Promise<void>((resolve) => releases.set(id, resolve)))
  const saved = ['a', 'a', 'b', 'c', 'd', 'e'].map((chatId) => ({ chatId }))
  const requests = { reconcile: async () => saved } as unknown as SendRequests
  let sends!: ReturnType<typeof useMessengerSends>
  function Harness() {
    sends = useMessengerSends({
      pending: [],
      requests,
      catchUp,
      refreshChats: async () => [],
      setSelectedId: vi.fn(),
      setDraftChat: vi.fn(),
      setError: vi.fn(),
    })
    return null
  }
  let recovery: Promise<void> | undefined
  try {
    await act(async () => {
      root.render(<Harness />)
    })
    await act(async () => {
      recovery = sends.reconcilePending()
    })
    expect(catchUp.mock.calls.flat()).toEqual(['a', 'b', 'c', 'd'])
    await act(async () => {
      releases.get('b')!()
    })
    expect(catchUp.mock.calls.flat()).toEqual(['a', 'b', 'c', 'd', 'e'])
    for (const release of releases.values()) release()
    await recovery
  } finally {
    for (const release of releases.values()) release()
    await recovery
    await act(async () => root.unmount())
    dom.window.close()
    vi.unstubAllGlobals()
  }
})
