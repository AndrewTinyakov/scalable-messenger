import { JSDOM } from 'jsdom'
import { act, StrictMode, useRef } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useExitAnimation } from './useExitAnimation'

let dom: JSDOM
let root: Root
let frames: FrameRequestCallback[]
let finish: () => void

function Panel() {
  const ref = useRef<HTMLDivElement>(null)
  useExitAnimation(ref, (ghost) => ghost.animate([{ opacity: 1 }, { opacity: 0 }], 100))
  return (
    <div ref={ref} id="panel" className="panel">
      <input type="radio" name="choice" id="choice" />
    </div>
  )
}

function flushFrames() {
  const pending = frames
  frames = []
  for (const frame of pending) frame(0)
}

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  frames = []
  vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => frames.push(frame))
  dom.window.HTMLElement.prototype.animate = function () {
    return {
      finished: new Promise<void>((resolve) => {
        finish = resolve
      }),
    } as unknown as Animation
  }
  const { createRoot } = await import('react-dom/client')
  root = createRoot(document.body.appendChild(document.createElement('div')))
})
afterEach(() => {
  dom.window.close()
  vi.unstubAllGlobals()
})

describe('exit animation', () => {
  it('fades an inert copy after a real unmount and removes it when the animation ends', async () => {
    await act(async () =>
      root.render(
        <StrictMode>
          <Panel />
        </StrictMode>,
      ),
    )
    flushFrames()
    expect(document.querySelector('.exit-ghost')).toBeNull()

    await act(async () => root.render(null))
    flushFrames()
    const ghost = document.querySelector<HTMLElement>('.exit-ghost')
    expect(ghost?.getAttribute('aria-hidden')).toBe('true')
    expect(ghost?.querySelector('[id], [name]')).toBeNull()
    expect(document.getElementById('panel')).toBeNull()

    await act(async () => finish())
    expect(document.querySelector('.exit-ghost')).toBeNull()
  })
})
