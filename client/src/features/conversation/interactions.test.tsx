import { JSDOM } from 'jsdom'
import { act, useState } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageItem } from '../../entities/message/MessageItem'
import { message } from '../../entities/message/chatRecovery.fixtures'
import type { Message } from '../../entities/message/model'
import type { ReaderPage } from '../../shared/api/featureDecode'
import { ChatKind } from '../../shared/api/generated/socket-vocabulary'
import { Dialog } from '../../shared/ui/Dialog'
import { MessageComposer } from '../message-send/MessageComposer'
import { InlineReaders } from './InlineReaders'

let MessageActionMenu: typeof import('./MessageActionMenu').MessageActionMenu
let ChatHeader: typeof import('../../widgets/chat-panel/ChatHeader').ChatHeader

let dom: JSDOM
let root: Root
let container: HTMLDivElement
beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  const { createRoot } = await import('react-dom/client')
  MessageActionMenu = (await import('./MessageActionMenu')).MessageActionMenu
  ChatHeader = (await import('../../widgets/chat-panel/ChatHeader')).ChatHeader
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  vi.useRealTimers()
  dom.window.close()
  vi.unstubAllGlobals()
})
async function type(text: string) {
  await act(async () => {
    const textarea = container.querySelector('textarea')!
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(
      textarea,
      text,
    )
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
async function click(label: string) {
  await act(async () => {
    container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click()
  })
}

describe('conversation interactions', () => {
  it('preserves the ordinary draft through edit cancellation and keeps failed edits available to retry', async () => {
    const original = message('1')
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error('Version changed. Retry after reopening edit.'))
      .mockResolvedValueOnce(undefined)
    const send = vi.fn(() => true)
    function Harness() {
      const [edit, setEdit] = useState<Message | undefined>()
      return (
        <>
          <button onClick={() => setEdit(original)}>Edit original</button>
          <MessageComposer
            chatId="chat"
            connected
            onSend={send}
            edit={edit}
            onSave={save}
            onCancelMode={() => setEdit(undefined)}
          />
        </>
      )
    }
    await act(async () => root.render(<Harness />))
    await type('ordinary draft')
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
    await type('edited text')
    await act(async () =>
      container
        .querySelector('textarea')!
        .dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    )
    expect(container.querySelector('textarea')!.value).toBe('ordinary draft')
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
    await type('new edit')
    await click('Save edit')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Version changed')
    expect(container.querySelector('textarea')!.value).toBe('new edit')
    await click('Save edit')
    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenLastCalledWith(original, 'new edit')
    expect(container.querySelector('textarea')!.value).toBe('ordinary draft')
    expect(send).not.toHaveBeenCalled()
  })

  it('sends the selected reply identity and ignores Enter while an IME composition is active', async () => {
    const original = message('1')
    const send = vi.fn(() => true)
    await act(async () =>
      root.render(
        <MessageComposer
          chatId="chat"
          connected
          onSend={send}
          reply={{ message: original, sender: 'Bob' }}
        />,
      ),
    )
    await type('reply text')
    await act(async () =>
      container.querySelector('textarea')!.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', {
          key: 'Enter',
          isComposing: true,
          bubbles: true,
        }),
      ),
    )
    expect(send).not.toHaveBeenCalled()
    await click('Send message')
    expect(send).toHaveBeenCalledExactlyOnceWith('chat', 'reply text', original.id)
    expect(container.querySelector('textarea')!.value).toBe('')
  })

  it('renders a saved tombstone without restoring a pending body or actions', async () => {
    const deleted = {
      ...message('1'),
      body: '',
      messageVersion: '2',
      deletedAt: '2026-11-04T10:00:00Z',
    }
    await act(async () =>
      root.render(
        <MessageItem
          message={deleted}
          send={{
            chatId: 'chat',
            requestId: 'request',
            body: 'Must stay deleted',
            status: 'saved',
            createdAt: deleted.createdAt,
            messageId: deleted.id,
          }}
          mine
          sender="Alice"
          group={false}
          connected
          onRetry={() => {}}
          onActions={() => {}}
        />,
      ),
    )
    expect(container.querySelector('.message-text')?.textContent).toBe('Message deleted')
    expect(container.textContent).not.toContain('Must stay deleted')
    expect(container.querySelector('[aria-label="Actions for your message"]')).toBeNull()
    expect(container.querySelector('.read-receipt')).toBeNull()
    expect(container.querySelector('time')?.dateTime).toBe(deleted.createdAt)
  })

  it('contains dialog keyboard focus and returns it when the dialog closes', async () => {
    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button onClick={() => setOpen(true)}>Open</button>
          {open && (
            <Dialog title="Delete this message?" onClose={() => setOpen(false)}>
              <button>Keep it</button>
              <button>Delete it</button>
            </Dialog>
          )}
        </>
      )
    }
    await act(async () => root.render(<Harness />))
    const trigger = container.querySelector<HTMLButtonElement>('button')!
    trigger.focus()
    await act(async () => trigger.click())
    const controls = [...container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
    expect(document.activeElement).toBe(controls[0])
    controls.at(-1)!.focus()
    await act(async () =>
      window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true })),
    )
    expect(document.activeElement).toBe(controls[0])
    await act(async () =>
      window.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    )
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it.each(['message', 'chat'])(
    'returns cancellation focus to the stable %s actions trigger',
    async (kind) => {
      const user = { id: 'alice', username: 'Alice' }
      function Harness() {
        const [open, setOpen] = useState(false)
        const [anchor, setAnchor] = useState<HTMLElement | null>(null)
        return (
          <>
            {kind === 'message' ? (
              <MessageItem
                message={message('1')}
                mine
                sender="Alice"
                group={false}
                connected
                onRetry={() => {}}
                onActions={(_message, target) => setAnchor(target)}
              />
            ) : (
              <ChatHeader
                chat={{
                  id: 'chat',
                  kind: ChatKind.DIRECT,
                  name: null,
                  members: [user],
                  memberCount: 1,
                  lastSequence: '1',
                }}
                currentUser={user}
                onBack={() => {}}
                onDelete={() => setOpen(true)}
              />
            )}
            {anchor && (
              <MessageActionMenu
                message={message('1')}
                anchor={anchor}
                keyboard={false}
                mine
                onReply={() => {}}
                onDelete={() => setOpen(true)}
                onSelect={() => {}}
                onClose={() => setAnchor(null)}
              />
            )}
            {open && (
              <Dialog title="Confirm deletion" onClose={() => setOpen(false)}>
                Delete?
              </Dialog>
            )}
          </>
        )
      }
      await act(async () => root.render(<Harness />))
      const trigger = container.querySelector<HTMLElement>(
        kind === 'message' ? '[data-message-id]' : '[aria-label="Chat actions"]',
      )!
      await act(async () => {
        if (kind === 'message')
          trigger.dispatchEvent(
            new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
          )
        else trigger.click()
      })
      const remove = document.querySelector<HTMLButtonElement>('.menu .danger-text')!
      remove.focus()
      await act(async () => remove.click())
      expect(container.querySelector('[role="dialog"]')).not.toBeNull()
      await act(async () =>
        window.dispatchEvent(
          new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        ),
      )
      expect(container.querySelector('[role="dialog"]')).toBeNull()
      expect(document.activeElement).toBe(trigger)
    },
  )

  it('shows an unavailable quote without exposing a missing target as an empty jump button', async () => {
    const quoted = {
      ...message('2'),
      replyToMessageId: 'hidden-target',
      replySenderId: null,
      replyBody: null,
      replyDeleted: null,
      replyVersion: null,
    }
    await act(async () =>
      root.render(
        <MessageItem
          message={quoted}
          mine={false}
          sender="Bob"
          group={false}
          connected
          onRetry={vi.fn()}
        />,
      ),
    )
    expect(container.querySelector('.message-quote')?.textContent).toContain(
      'Original message unavailable',
    )
    expect(container.querySelector<HTMLButtonElement>('.message-quote')?.disabled).toBe(true)
  })

  it('shows server read timestamps, paginates once and expires inline timestamps by message creation age', async () => {
    vi.useFakeTimers()
    const now = '2026-11-04T10:00:00Z'
    const first: ReaderPage = {
      readers: [{ userId: 'reader-1', username: 'Bob', readAt: '2026-11-04T09:30:00Z' }],
      nextUserId: 'reader-1',
      detailsAvailable: true,
      serverTime: now,
      detailsExpiresAt: '2026-11-04T10:00:01Z',
    }
    const load = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce({
        ...first,
        readers: [{ userId: 'reader-2', username: 'Carol', readAt: '2026-11-04T09:45:00Z' }],
        nextUserId: null,
      })
    await act(async () => root.render(<InlineReaders message={message('1')} load={load} />))
    expect(container.querySelector('time')?.dateTime).toBe('2026-11-04T09:30:00Z')
    const more = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'More readers',
    )!
    await act(async () => {
      more.click()
      more.click()
    })
    expect(load).toHaveBeenCalledTimes(2)
    expect(load).toHaveBeenLastCalledWith('chat', 'message-1', 'reader-1')
    expect(container.querySelectorAll('time')).toHaveLength(2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(container.textContent).toContain('messages created within the last seven days')
    expect(container.querySelectorAll('time')).toHaveLength(0)
  })

  it.each([false, true])(
    'removes deleted-message read details even with a pending request: %s',
    async (pending) => {
      let resolve!: (page: ReaderPage) => void
      const page: ReaderPage = {
        readers: [{ userId: 'reader-1', username: 'Bob', readAt: '2026-11-04T09:30:00Z' }],
        nextUserId: 'reader-1',
        detailsAvailable: true,
        serverTime: '2026-11-04T10:00:00Z',
        detailsExpiresAt: '2026-11-05T10:00:00Z',
      }
      const load = vi.fn(() =>
        pending
          ? new Promise<ReaderPage>((done) => {
              resolve = done
            })
          : Promise.resolve(page),
      )
      const original = message('1')
      await act(async () => root.render(<InlineReaders message={original} load={load} />))
      if (!pending) expect(container.querySelectorAll('time')).toHaveLength(1)
      await act(async () =>
        root.render(
          <InlineReaders
            message={{ ...original, deletedAt: '2026-11-04T10:00:00Z', body: '' }}
            load={load}
          />,
        ),
      )
      if (pending) await act(async () => resolve(page))
      expect(container.textContent).toContain('Read times are unavailable for deleted messages.')
      expect(container.querySelectorAll('time')).toHaveLength(0)
      expect(container.textContent).not.toContain('More readers')
      expect(container.textContent).not.toContain('Loading readers')
      expect(load).toHaveBeenCalledTimes(1)
    },
  )
})
