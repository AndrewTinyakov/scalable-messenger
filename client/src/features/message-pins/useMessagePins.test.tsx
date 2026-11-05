import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../../entities/message/model'
import type { api } from '../../shared/api/http'
import { useMessagePins, type MessagePins } from './useMessagePins'

type SessionApi = ReturnType<typeof api.forSession>

const chatId = '01ARZ3NDEKTSV4RRFFQ69G5FAW'
const pageSize = 50

const message = (sequence: number, body: string): Message => ({
  id: `m${sequence}`,
  chatId,
  sequence: String(sequence),
  senderId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  body,
  createdAt: '2026-11-05T10:00:00Z',
  messageVersion: '1',
  editedAt: null,
  deletedAt: null,
  replyToMessageId: null,
  replySenderId: null,
  replyBody: null,
  replyDeleted: null,
  replyVersion: null,
})

let root: Root
let latest: MessagePins
let bodies: Map<number, string>
let requests: (string | undefined)[]
let holding: boolean
let held: (() => void)[]

async function pinnedMessages(_chatId: string, beforeSequence?: string) {
  if (holding) await new Promise<void>((resolve) => held.push(resolve))
  requests.push(beforeSequence)
  const sequences = [...bodies.keys()].sort((a, b) => b - a)
  const older = sequences.filter(
    (sequence) => beforeSequence === undefined || sequence < Number(beforeSequence),
  )
  const slice = older.slice(0, pageSize)
  return {
    pins: slice.map((sequence) => ({
      message: message(sequence, bodies.get(sequence)!),
      scope: 'EVERYONE' as const,
    })),
    totalCount: sequences.length,
    pinnedMessageIds: sequences.map((sequence) => `m${sequence}`),
    nextBeforeSequence: older.length > pageSize ? String(slice.at(-1)) : null,
  }
}

async function releaseNext() {
  await act(async () => {
    while (!held.length) await new Promise((resolve) => setTimeout(resolve, 0))
    held.shift()!()
  })
}

const sessionApi = { pinnedMessages } as unknown as SessionApi

function Probe() {
  latest = useMessagePins(chatId, sessionApi, true)
  return null
}

beforeEach(async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  bodies = new Map(Array.from({ length: 60 }, (_, index) => [index + 1, `body ${index + 1}`]))
  requests = []
  holding = false
  held = []
  root = createRoot(dom.window.document.body.appendChild(dom.window.document.createElement('div')))
  await act(async () => root.render(<Probe />))
})

afterEach(async () => {
  await act(async () => root.unmount())
  vi.unstubAllGlobals()
})

describe('useMessagePins', () => {
  it('refreshes the content of every loaded page, not only the newest one', async () => {
    await act(async () => latest.loadOlder())
    expect(latest.pins).toHaveLength(60)
    expect(latest.hasOlder).toBe(false)

    bodies.set(5, 'EDITED')
    requests = []
    await act(async () => latest.refresh())

    expect(requests).toEqual([undefined, '11'])
    expect(latest.pins).toHaveLength(60)
    expect(latest.pins.find((pin) => pin.message.id === 'm5')?.message.body).toBe('EDITED')
  })

  it('loads only the newest page when no older page was opened', async () => {
    requests = []
    await act(async () => latest.refresh())
    expect(requests).toEqual([undefined])
    expect(latest.pins).toHaveLength(50)
    expect(latest.hasOlder).toBe(true)
  })
  it('keeps a page loaded while an earlier refresh was in flight', async () => {
    holding = true
    let refreshing!: Promise<void>
    act(() => {
      refreshing = latest.refresh()
    })
    holding = false
    let loading!: Promise<void>
    act(() => {
      loading = latest.loadOlder()
    })
    await releaseNext()
    await act(async () => {
      await refreshing
      await loading
    })

    expect(latest.pins).toHaveLength(60)
    expect(latest.hasOlder).toBe(false)
  })

  it('restarts when the pinned set changes between page requests', async () => {
    await act(async () => latest.loadOlder())
    holding = true
    let refreshing!: Promise<void>
    act(() => {
      refreshing = latest.refresh()
    })
    await releaseNext()
    bodies.clear()
    holding = false
    await releaseNext()
    await act(async () => refreshing)

    expect(latest.pins).toEqual([])
    expect(latest.total).toBe(0)
    expect(latest.pinnedIds.size).toBe(0)
    expect(latest.hasOlder).toBe(false)
  })
  it('publishes a consistent pass while further refreshes keep queuing', async () => {
    await act(async () => latest.loadOlder())
    holding = true
    let refreshing!: Promise<void>
    act(() => {
      refreshing = latest.refresh()
    })
    await releaseNext()
    act(() => {
      void latest.refresh()
    })
    bodies.set(5, 'EDITED')
    await releaseNext()
    await act(async () => {
      while (!held.length) await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(latest.pins).toHaveLength(60)
    expect(latest.pins.find((pin) => pin.message.id === 'm5')?.message.body).toBe('EDITED')

    holding = false
    await releaseNext()
    await act(async () => refreshing)
  })
})
