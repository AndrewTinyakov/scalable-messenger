import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CreateChatDialog } from './CreateChatDialog'

let dom: JSDOM
let root: Root
let container: HTMLDivElement

const session = { user: { id: 'me', username: 'alice' }, deviceId: 'device' }

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  dom.window.close()
  vi.unstubAllGlobals()
})

describe('create chat dialog', () => {
  it('closes on Escape from anywhere on the page', async () => {
    const close = vi.fn()
    await act(async () =>
      root.render(
        <CreateChatDialog
          session={session}
          currentUserId="me"
          initialMode="group"
          onClose={close}
          onDirect={async () => {}}
          onGroup={async () => {}}
        />,
      ),
    )
    await act(async () =>
      document.body.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    )
    expect(close).toHaveBeenCalledOnce()
  })
})
