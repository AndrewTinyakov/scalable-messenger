import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEnteringEntries } from './useEnteringEntries'

let dom: JSDOM
let root: Root
let seen: string[][]

interface View {
  empty?: boolean
  latest?: boolean
}

function Probe({ chatId, keys, view }: { chatId: string; keys: string[]; view: View }) {
  seen.push([
    ...useEnteringEntries(
      chatId,
      keys.map((key) => ({ key, sequence: key.startsWith('pending') ? undefined : key })),
      { knownEmpty: view.empty ?? false, latest: view.latest ?? true },
    ),
  ])
  return null
}

async function show(chatId: string, keys: string[], view: View = {}) {
  await act(async () => root.render(<Probe chatId={chatId} keys={keys} view={view} />))
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

  it('does not animate a chat switch, a burst or history paged in either direction', async () => {
    await show('a', ['1'])
    expect(await show('b', ['5', '6'])).toEqual([])
    expect(await show('b', ['5', '6', '7', '8', '9', '10'])).toEqual([])
    await show('c', ['1'], { latest: false })
    expect(await show('c', ['1', '2', '3', '4'], { latest: false })).toEqual([])
    expect(await show('c', ['1', '2', '3', '4', '5'])).toEqual([])
    expect(await show('c', ['1', '2', '3', '4', '5', '6'])).toEqual(['6'])
  })

  it('animates own sends, and peer messages that land before a pending send', async () => {
    await show('a', ['1'])
    expect(await show('a', ['1', 'pending-a'])).toEqual(['pending-a'])
    expect(await show('a', ['1', '2', 'pending-a'])).toEqual(['2'])
    expect(await show('a', ['1', '2', '3'])).toEqual(['3'])
  })

  it('animates an arrival that lands with the deletion of the newest saved message', async () => {
    await show('a', ['1', '2', 'pending-a'])
    expect(await show('a', ['1', '3', 'pending-a'])).toEqual(['3'])
  })

  it('keeps animating arrivals after only pending sends remain', async () => {
    await show('a', ['1', 'pending-a'])
    await show('a', ['pending-a'])
    expect(await show('a', ['2', 'pending-a'])).toEqual(['2'])

    await show('draft', [], { empty: true })
    await show('draft', ['pending-a'], { empty: true })
    await show('draft', ['pending-a'])
    expect(await show('draft', ['pending-a', 'pending-b'])).toEqual(['pending-b'])
  })

  it('animates the first message of a chat known to be empty but not history behind a loading chat', async () => {
    await show('a', [], { empty: true })
    expect(await show('a', ['1'], { empty: true })).toEqual(['1'])
    await show('b', [])
    expect(await show('b', ['1', '2'])).toEqual([])
    await show('c', ['pending-c'])
    expect(await show('c', ['1', '2', 'pending-c'])).toEqual([])
  })
})
