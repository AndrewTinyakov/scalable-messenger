import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectionStatus } from './ConnectionStatus'

let dom: JSDOM
let root: Root
let container: HTMLDivElement

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
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
  vi.useRealTimers()
  dom.window.close()
  vi.unstubAllGlobals()
})

describe('connection status', () => {
  it('shows nothing while connected', async () => {
    await act(async () =>
      root.render(
        <ConnectionStatus
          connection="connected"
          networkOnline
          nextRetryAt={null}
          onRetry={() => {}}
        />,
      ),
    )
    expect(container.textContent).toBe('')
  })

  it('counts down to the scheduled retry and lets the user retry now', async () => {
    const retry = vi.fn()
    await act(async () =>
      root.render(
        <ConnectionStatus
          connection="offline"
          networkOnline
          nextRetryAt={1_008_000}
          onRetry={retry}
        />,
      ),
    )
    expect(container.textContent).toContain('Reconnecting in 8 s')
    await act(async () => {
      vi.advanceTimersByTime(3000)
    })
    expect(container.textContent).toContain('Reconnecting in 5 s')
    await act(async () => container.querySelector('button')!.click())
    expect(retry).toHaveBeenCalledOnce()
  })

  it('says it is connecting once the wait is over and waits for network when offline', async () => {
    await act(async () =>
      root.render(
        <ConnectionStatus
          connection="connecting"
          networkOnline
          nextRetryAt={null}
          onRetry={() => {}}
        />,
      ),
    )
    expect(container.textContent).toBe('Connecting…')
    await act(async () =>
      root.render(
        <ConnectionStatus
          connection="offline"
          networkOnline={false}
          nextRetryAt={null}
          onRetry={() => {}}
        />,
      ),
    )
    expect(container.textContent).toBe('Waiting for network…')
  })
})
