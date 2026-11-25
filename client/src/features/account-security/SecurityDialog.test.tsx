import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActiveSession, Session } from '../../entities/session/model'
import { SecurityDialog } from './SecurityDialog'

const session: Session = {
  user: { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', username: 'alice' },
  deviceId: 'device',
}
const current: ActiveSession = {
  id: 'a'.repeat(64),
  deviceLabel: 'Chrome on macOS',
  createdAt: '2026-11-01T10:00:00Z',
  lastUsedAt: '2026-11-17T10:00:00Z',
  current: true,
}
const phone: ActiveSession = {
  id: 'b'.repeat(64),
  deviceLabel: 'Safari on iOS',
  createdAt: '2026-11-02T10:00:00Z',
  lastUsedAt: '2026-11-16T10:00:00Z',
  current: false,
}
const laptop: ActiveSession = {
  id: 'c'.repeat(64),
  deviceLabel: 'Firefox on Windows',
  createdAt: '2026-11-03T10:00:00Z',
  lastUsedAt: '2026-11-15T10:00:00Z',
  current: false,
}

interface Request {
  url: URL
  method: string
  options: RequestInit
}

let dom: JSDOM
let root: Root
let container: HTMLDivElement
let requests: Request[]
let sessions: ActiveSession[]
let respond: (request: Request) => Response | undefined
const onClose = vi.fn()
const onSignOut = vi.fn()
const onSessionInvalid = vi.fn()

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const { createRoot } = await import('react-dom/client')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  requests = []
  sessions = [current, phone, laptop]
  respond = () => undefined
  for (const callback of [onClose, onSignOut, onSessionInvalid]) callback.mockClear()
  vi.stubGlobal('fetch', async (input: string, options: RequestInit = {}) => {
    const request = { url: new URL(input), method: options.method ?? 'GET', options }
    requests.push(request)
    const response = respond(request)
    if (response) return response
    const path = request.url.pathname
    if (request.method === 'GET' && path === '/api/v1/auth/sessions')
      return Response.json({ sessions })
    if (request.method === 'DELETE' && path.startsWith('/api/v1/auth/sessions/')) {
      sessions = sessions.filter((item) => item.id !== path.split('/').pop())
      return new Response(null, { status: 204 })
    }
    if (request.method === 'POST' && path === '/api/v1/auth/sessions/revoke-others') {
      const revokedSessions = sessions.filter((item) => !item.current).length
      sessions = sessions.filter((item) => item.current)
      return Response.json({ revokedSessions })
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`)
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  dom.window.close()
  vi.unstubAllGlobals()
})

async function render() {
  await act(async () =>
    root.render(
      <SecurityDialog
        session={session}
        onClose={onClose}
        onSignOut={onSignOut}
        onSessionInvalid={onSessionInvalid}
      />,
    ),
  )
}

function button(label: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) => (element.getAttribute('aria-label') ?? element.textContent) === label,
  )
  expect(found, `Button ${label}`).toBeDefined()
  return found!
}

async function click(label: string) {
  await act(async () => button(label).click())
}

function rows() {
  return [...container.querySelectorAll('[aria-label="Signed-in devices"] > li')].map(
    (row) => row.textContent,
  )
}

async function type(id: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`#${id}`)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      value,
    )
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}

async function submitPassword() {
  const form = container.querySelector<HTMLFormElement>('form.security-password')!
  await act(async () => {
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
  })
}

function text() {
  return container.textContent ?? ''
}

describe('account security dialog', () => {
  it('lists devices with the current one marked and signs out another device', async () => {
    await render()
    expect(rows()).toEqual([
      expect.stringContaining('Chrome on macOSThis device'),
      expect.stringContaining('Safari on iOS'),
      expect.stringContaining('Firefox on Windows'),
    ])
    expect(requests[0].options.headers).toMatchObject({
      'X-Messenger-User': session.user.id,
      'X-Messenger-Device': session.deviceId,
    })

    await click('Sign out Safari on iOS')

    const removal = requests.find((request) => request.method === 'DELETE')!
    expect(removal.url.pathname).toBe(`/api/v1/auth/sessions/${phone.id}`)
    expect(removal.options.headers).toMatchObject({ 'X-Messenger-CSRF': '1' })
    expect(rows()).toHaveLength(2)
    expect(text()).toContain('Signed out Safari on iOS.')
    expect(onSignOut).not.toHaveBeenCalled()
  })

  it('signs out the current device through the normal logout flow', async () => {
    await render()
    await click('Sign out of this device')
    expect(onSignOut).toHaveBeenCalledTimes(1)
    expect(requests.filter((request) => request.method !== 'GET')).toEqual([])
  })

  it('confirms before signing out every other device and reports the count', async () => {
    await render()
    await click('Sign out all other devices')
    expect(requests.filter((request) => request.method !== 'GET')).toEqual([])
    await click('Sign out all')
    expect(text()).toContain('Signed out 2 other devices.')
    expect(rows()).toEqual([expect.stringContaining('This device')])
    expect(button('Sign out all other devices').disabled).toBe(true)
  })

  it('shows a load failure with a retry and hands expired sessions back to the app', async () => {
    respond = () =>
      Response.json({ detail: 'A required service is temporarily unavailable' }, { status: 400 })
    await render()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'A required service is temporarily unavailable',
    )
    respond = () => undefined
    await click('Try again')
    expect(rows()).toHaveLength(3)

    respond = (request) =>
      request.method === 'DELETE'
        ? Response.json({ detail: 'Session expired or invalid' }, { status: 401 })
        : undefined
    await click('Sign out Firefox on Windows')
    expect(onSessionInvalid).toHaveBeenCalledTimes(1)
  })

  it('validates the new password locally and reports server rejections', async () => {
    await render()
    await type('security-current-password', 'old-password')
    await type('security-new-password', 'new-password-1')
    await type('security-confirm-password', 'new-password-2')
    await submitPassword()
    expect(text()).toContain('New passwords do not match.')
    expect(requests.some((request) => request.url.pathname === '/api/v1/auth/password')).toBe(false)

    respond = (request) =>
      request.url.pathname === '/api/v1/auth/password'
        ? Response.json(
            { detail: 'Too many attempts. Try again later.', code: 'TOO_MANY_ATTEMPTS' },
            { status: 429, headers: { 'Retry-After': '600' } },
          )
        : undefined
    await type('security-confirm-password', 'new-password-1')
    await submitPassword()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Too many attempts. Try again later.',
    )
    expect(
      requests.filter((request) => request.url.pathname === '/api/v1/auth/password'),
    ).toHaveLength(1)
  })

  it('changes the password, clears the form and refreshes the device list', async () => {
    respond = (request) => {
      if (request.url.pathname !== '/api/v1/auth/password') return undefined
      sessions = [current]
      return Response.json({ revokedSessions: 2 })
    }
    await render()
    await type('security-current-password', 'old-password')
    await type('security-new-password', 'new-password-1')
    await type('security-confirm-password', 'new-password-1')
    await submitPassword()

    const change = requests.find((request) => request.url.pathname === '/api/v1/auth/password')!
    expect(change.method).toBe('POST')
    expect(JSON.parse(String(change.options.body))).toEqual({
      currentPassword: 'old-password',
      newPassword: 'new-password-1',
    })
    expect(change.options.headers).toMatchObject({
      'X-Messenger-CSRF': '1',
      'X-Messenger-User': session.user.id,
    })
    expect(text()).toContain('Password changed. Signed out 2 other devices.')
    expect(container.querySelector<HTMLInputElement>('#security-current-password')!.value).toBe('')
    expect(rows()).toHaveLength(1)
  })
})
