import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let Menu: typeof import('./Menu').Menu
let MenuItem: typeof import('./Menu').MenuItem
let dom: JSDOM
let root: Root
let container: HTMLDivElement

function rect(left: number, top: number, width: number, height: number) {
  return { left, top, width, height, right: left + width, bottom: top + height } as DOMRect
}

async function open(
  anchorRect: DOMRect,
  props: { align?: 'start' | 'end'; point?: { x: number; y: number } },
  renderedScale = 1,
) {
  const anchor = document.createElement('button')
  anchor.getBoundingClientRect = () => anchorRect
  document.body.append(anchor)
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    return this === anchor ? anchorRect : rect(0, 0, 200 * renderedScale, 120 * renderedScale)
  }
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 200,
  })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 120,
  })
  const close = vi.fn()
  await act(async () =>
    root.render(
      <Menu label="Options" anchor={anchor} onClose={close} {...props}>
        <MenuItem icon={null}>Delete chat</MenuItem>
      </Menu>,
    ),
  )
  return { menu: document.querySelector<HTMLElement>('.menu')!, close }
}

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(dom.window, 'innerWidth', { value: 1000 })
  Object.defineProperty(dom.window, 'innerHeight', { value: 700 })
  container = document.createElement('div')
  document.body.append(container)
  const { createRoot } = await import('react-dom/client')
  ;({ Menu, MenuItem } = await import('./Menu'))
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  dom.window.close()
  vi.unstubAllGlobals()
})

describe('floating menu placement', () => {
  it('stays inside the right edge when the anchor sits against it', async () => {
    const { menu } = await open(rect(960, 20, 36, 36), {})
    expect(parseFloat(menu.style.left)).toBe(792)
    expect(parseFloat(menu.style.top)).toBe(62)
  })

  it('uses its layout size while its opening animation scales it down', async () => {
    const { menu } = await open(rect(960, 20, 36, 36), {}, 0.9)
    expect(parseFloat(menu.style.left)).toBe(792)
  })

  it('flips above an anchor that has no room below', async () => {
    const { menu } = await open(rect(100, 640, 40, 40), { align: 'end' })
    expect(parseFloat(menu.style.top)).toBe(514)
    expect(parseFloat(menu.style.left)).toBe(8)
  })

  it('opens at the pointer and flips away from both edges', async () => {
    const { menu } = await open(rect(0, 0, 10, 10), { point: { x: 990, y: 690 } })
    expect(parseFloat(menu.style.left)).toBe(790)
    expect(parseFloat(menu.style.top)).toBe(570)
    expect(menu.style.transformOrigin).toBe('bottom right')
  })

  it('closes on an outside press and on Escape with focus outside it, and keeps the anchor press for its owner', async () => {
    const { close } = await open(rect(100, 100, 40, 40), {})
    await act(async () => {
      document.body.lastElementChild!.dispatchEvent(
        new dom.window.MouseEvent('pointerdown', { bubbles: true }),
      )
    })
    expect(close).not.toHaveBeenCalled()
    await act(async () => {
      container.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(close).toHaveBeenCalledTimes(1)
    await act(async () => {
      document.body.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      )
    })
    expect(close).toHaveBeenCalledTimes(2)
  })
})
