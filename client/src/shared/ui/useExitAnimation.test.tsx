import { JSDOM } from 'jsdom'
import { act, StrictMode, useRef } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useExitAnimation } from './useExitAnimation'

let dom: JSDOM
let root: Root
let frames: Map<number, FrameRequestCallback>
let settle: { finish(): void; cancel(): void }

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
  const pending = [...frames.values()]
  frames.clear()
  for (const frame of pending) frame(0)
}

async function mountAndClose() {
  await act(async () =>
    root.render(
      <StrictMode>
        <Panel />
      </StrictMode>,
    ),
  )
  await act(async () => root.render(null))
  flushFrames()
  return [...document.querySelectorAll<HTMLElement>('.exit-ghost')]
}

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  frames = new Map()
  let nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => {
    frames.set(++nextFrame, frame)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  dom.window.HTMLElement.prototype.animate = function () {
    return {
      finished: new Promise<void>((resolve, reject) => {
        settle = { finish: resolve, cancel: () => reject(new Error('cancelled')) }
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
  it('fades one inert copy after a real unmount and removes it when the fade ends', async () => {
    const ghosts = await mountAndClose()
    expect(ghosts).toHaveLength(1)
    const [ghost] = ghosts
    expect(ghost.inert).toBe(true)
    expect(ghost.getAttribute('aria-hidden')).toBe('true')
    expect(ghost.querySelector('[id], [name]')).toBeNull()
    expect(document.getElementById('panel')).toBeNull()

    await act(async () => settle.finish())
    expect(document.querySelector('.exit-ghost')).toBeNull()
  })

  it('removes the copy when the fade is cancelled', async () => {
    expect(await mountAndClose()).toHaveLength(1)
    await act(async () => settle.cancel())
    expect(document.querySelector('.exit-ghost')).toBeNull()
  })

  it('leaves nothing behind while the component stays mounted', async () => {
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
  })
})
