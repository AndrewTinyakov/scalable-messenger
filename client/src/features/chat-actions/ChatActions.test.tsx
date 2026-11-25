import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Chat } from '../../entities/chat/model'
import { ChatKind } from '../../shared/api/generated/socket-vocabulary'

let ChatActions: typeof import('./ChatActions').ChatActions
let dom: JSDOM
let root: Root
let container: HTMLDivElement

const user = { id: 'me', username: 'alice' }
const chat: Chat = {
  id: 'group',
  kind: ChatKind.GROUP,
  name: 'Team',
  members: [],
  memberCount: 3,
  lastSequence: '4',
  ownerId: 'someone-else',
}

async function render(target: Chat, onDelete = vi.fn(async () => {})) {
  const onClear = vi.fn(async () => {})
  const onClose = vi.fn()
  const anchor = document.createElement('button')
  document.body.append(anchor)
  await act(async () =>
    root.render(
      <ChatActions
        target={{ chat: target, anchor, keyboard: false }}
        user={user}
        onDelete={onDelete}
        onClear={onClear}
        onClose={onClose}
      />,
    ),
  )
  return { onDelete, onClear, onClose }
}

async function press(label: string) {
  const control = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === label,
  )!
  await act(async () => control.click())
}

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  const { createRoot } = await import('react-dom/client')
  ChatActions = (await import('./ChatActions')).ChatActions
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  dom.window.close()
  vi.unstubAllGlobals()
})

describe('sidebar chat actions', () => {
  it('confirms before deleting the targeted chat and then closes', async () => {
    const { onDelete, onClose } = await render(chat)
    await press('Delete chat')
    expect(onDelete).not.toHaveBeenCalled()
    await press('Delete')
    expect(onDelete).toHaveBeenCalledWith('group', 'SELF')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('offers everyone scope only to the group owner', async () => {
    await render(chat)
    await press('Clear history')
    expect(document.querySelector('input[value="EVERYONE"]')).toBeNull()
    await act(async () => root.unmount())
    const { createRoot } = await import('react-dom/client')
    root = createRoot(container)
    const { onClear } = await render({ ...chat, ownerId: user.id })
    await press('Clear history')
    await act(async () =>
      document.querySelector<HTMLInputElement>('input[value="EVERYONE"]')!.click(),
    )
    await press('Clear')
    expect(onClear).toHaveBeenCalledWith('group', 'EVERYONE')
  })

  it('keeps the dialog open with the reason when the action fails', async () => {
    const { onClose } = await render(
      chat,
      vi.fn(async () => {
        throw new Error('Chat is busy')
      }),
    )
    await press('Delete chat')
    await press('Delete')
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Chat is busy')
    expect(onClose).not.toHaveBeenCalled()
  })
})
