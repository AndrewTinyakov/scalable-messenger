import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEnteringEntries } from './useEnteringEntries'

let dom: JSDOM
let root: Root
let seen: string[][]

function Probe({
  chatId,
  keys,
  empty = false,
}: {
  chatId: string
  keys: string[]
  empty?: boolean
}) {
  seen.push([
    ...useEnteringEntries(
      chatId,
      keys.map((key) => ({ key, saved: !key.startsWith('pending') })),
      empty,
    ),
  ])
  return null
}

async function show(chatId: string, keys: string[], empty = false) {
  await act(async () => root.render(<Probe chatId={chatId} keys={keys} empty={empty} />))
  return seen.at(-1)
}

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  seen = []
  const { createRoot } = await import('react-dom/client')
  root = createRoot(document.body.appendChild(document.createElement('div')))
})
afterEach(async () => {
  await act(async () => root.unmount())
  dom.window.close()
  vi.unstubAllGlobals()
})

describe('entering message entries', () => {
  it('animates only messages that arrive at the end of an open chat', async () => {
    expect(await show('a', ['1', '2'])).toEqual([])
    expect(await show('a', ['1', '2', '3'])).toEqual(['3'])
    expect(await show('a', ['1', '2', '3'])).toEqual([])
    expect(await show('a', ['0', '1', '2', '3'])).toEqual([])
  })

  it('does not animate older history prepended to a short chat', async () => {
    await show('a', ['2', '3'])
    expect(await show('a', ['1', '2', '3'])).toEqual([])
    expect(await show('a', ['1', '2', '3', '4'])).toEqual(['4'])
  })

  it('animates a peer message that lands before an own pending send', async () => {
    await show('a', ['1'])
    expect(await show('a', ['1', 'pending-a'])).toEqual(['pending-a'])
    expect(await show('a', ['1', '2', 'pending-a'])).toEqual(['2'])
  })

  it('does not animate a chat switch or a page of history', async () => {
    await show('a', ['1'])
    expect(await show('b', ['x', 'y'])).toEqual([])
    expect(await show('b', ['x', 'y', 'p', 'q', 'r', 's'])).toEqual([])
  })

  it('animates the first message of a chat known to be empty but not a loading chat', async () => {
    await show('a', [], true)
    expect(await show('a', ['1'], true)).toEqual(['1'])
    await show('b', [])
    expect(await show('b', ['1', '2'])).toEqual([])
  })
})
